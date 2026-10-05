import assert from "node:assert/strict";
import { AlgorandClient, Config } from "@algorandfoundation/algokit-utils";
// Reference implementation for TypeScript using pure strings
import {
  fromBoxes,
  MAX_KEY_SIZE,
  MAX_STRUCT_SIZE,
  MaxSizeError,
  PREFIX,
  toBoxes,
  toMBR,
} from "@algorandfoundation/arc87";
import { faker } from "@faker-js/faker";
import { ABIType } from "algosdk";

import { deploy } from "../src/deploy.js";

// Total applications created from the faker sample
const TOTAL = Number(process.env.DEMO_TOTAL ?? 3);

// Configure AlgoKit
Config.configure({
  debug: false,
  logger: {
    verbose() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  },
});

// Example Type for Testing
type Animal = {
  id: number;
  type: string;
  avatar: string;
  petName: string;
  birthdate: string;
  registeredAt: string;
  tags: string[];
  location: {
    country: string;
    city: string;
    state: string;
  };
};

// Factory for the example objects
export function createAnimal(): Animal {
  return {
    id: faker.number.int({ max: Number.MAX_SAFE_INTEGER }),
    type: faker.animal.type(),
    avatar: faker.image.avatar(),
    petName: faker.animal.petName(),
    birthdate: faker.date.birthdate().toISOString(),
    registeredAt: faker.date.past().toISOString(),
    tags: faker.helpers.arrayElements(["cute", "fluffy", "fast", "sleepy"], 2),
    location: {
      country: faker.location.country(),
      city: faker.location.city(),
      state: faker.location.state(),
    },
  };
}

// Create a sampling of data
export const animals = faker.helpers.multiple(createAnimal, { count: TOTAL });

// Spec corner cases: an escaped segment (`a.b` → `${a.b}`) and a
// bracket-looking segment (`c[0]` → `${c[0]}`, a literal, not an index).
export const special = {
  name: "special",
  "a.b": "dotted key",
  "c[0]": "bracket key",
  nested: { "x.y": ["first", "second"] },
};

// A key name longer than MAX_KEY_SIZE bytes cannot be stored: ARC-87 leaves
// templatization to a future specification, so the library rejects it.
const LONG_KEY =
  "this is a really long key that for some reason is extra long even though it probably doesn't need to be this long but idk maybe someone has a key this long";
assert.throws(
  () => toMBR({ [LONG_KEY]: "data for super long key" }),
  MaxSizeError,
  "long keys are rejected",
);

// Every object to be deployed, keyed by application name. Deployment is
// idempotent per name, so the name doubles as a version of the sample shape.
const SPECIAL = "special-escaping";
const samples: Record<string, unknown> = Object.fromEntries([
  ...animals.map((animal) => [`animal-${animal.id}`, animal]),
  [SPECIAL, special],
]);

// Calculate the totals
const mbrs = Object.fromEntries(
  Object.entries(samples).map(([name, obj]) => [name, toMBR(obj)]),
);
const totals = Object.values(mbrs);
const totalMBR = totals.reduce((p, c) => p + c, 0n);
const averageMBR = totalMBR / BigInt(totals.length);

// Log the expected results
console.log("Example Animal:", faker.helpers.arrayElement(animals));
console.log("Special object boxes:");
for (const [key, value] of toBoxes(special)) {
  console.log(`  ${key} = ${value}`);
}
console.log(
  `Key longer than ${MAX_KEY_SIZE} bytes rejected with MaxSizeError: "${LONG_KEY.slice(0, 24)}…"`,
);
console.log(`\nTotal Objects: ${totals.length}`);
console.log(`Total MBR: ${totalMBR.microAlgo().algo}`);
console.log(`Average MBR: ${averageMBR.microAlgo().algo}`);
console.log(
  `Max MBR: ${totals.reduce((p, c) => (p > c ? p : c)).microAlgo().algo}`,
);
console.log(
  `Min MBR: ${totals.reduce((p, c) => (p < c ? p : c)).microAlgo().algo}\n`,
);

// Attempt to deploy the objects and resolve their state on-chain
try {
  // Configure the client
  const algorand = AlgorandClient.fromEnvironment();
  const deployer = await algorand.account.fromEnvironment("DEPLOYER");
  const balance = await algorand.client.algod
    .accountInformation(deployer.addr)
    .do()
    .then((info) => info.amount);

  // Log accounts and preflight check
  console.log(`Deploying with ${deployer.addr}`);
  console.log(`Account balance: ${balance.microAlgo().algo}`);
  if (balance < totalMBR) {
    throw new Error(
      `Insufficient funds to deploy ${totalMBR.microAlgo().algo} MBR`,
    );
  }
  console.log(
    `Deploying to ${await algorand.client.network().then((n) => n.genesisId)}`,
  );

  // Deploy every object on-chain (sequentially: one deployer account)
  const appIds: Record<string, bigint> = {};
  for (const [name, obj] of Object.entries(samples)) {
    appIds[name] = await deploy(algorand, deployer, name, obj);
    console.log(`Deployed ${name} as app ${appIds[name]}`);
  }

  // Log the results of the deployment
  console.log(`\nDeployed ${totals.length} objects`);
  const resultBalance = await algorand.client.algod
    .accountInformation(deployer.addr)
    .do()
    .then((info) => info.amount);
  const bDiff = balance - resultBalance;
  console.log(`Deployed with ${bDiff.microAlgo().algo} spent`);
  console.log(
    `Final Average: ${(bDiff / BigInt(totals.length)).microAlgo().algo}\n`,
  );

  // Resolve all objects from their boxes on-chain and check they round-trip
  for (const [name, obj] of Object.entries(samples)) {
    const resolved = await fromBoxes(algorand, appIds[name]);
    assert.deepEqual(resolved, obj, `${name} did not round-trip`);
  }
  const resolvedSpecial = await fromBoxes<typeof special>(
    algorand,
    appIds[SPECIAL],
  );
  console.log("Sample Object Resolved From Chain:", resolvedSpecial);

  // Inspect the raw box names of the special object
  const names = await algorand.app.getBoxNames(appIds[SPECIAL]);
  const boxNames = names.map((n) => n.name).sort();
  console.log("\nSpecial object box names on chain:", boxNames);
  assert.ok(boxNames.includes(`${PREFIX}\${a.b}`), "escaped key is present");
  assert.ok(
    boxNames.includes(`${PREFIX}\${c[0]}`),
    "bracket literal is present",
  );
  assert.ok(
    boxNames.includes(`${PREFIX}nested.\${x.y}[1]`),
    "canonical [N] index is present",
  );
  assert.ok(
    boxNames.every((n) => Buffer.byteLength(n) <= Number(MAX_KEY_SIZE)),
    "no box name exceeds MAX_KEY_SIZE",
  );
  console.log("\nAll objects round-tripped through boxes.");

  // A store capped at MAX_STRUCT_SIZE (4094 bytes) holding an ARC-4 struct leaf:
  // every leaf of such a store can be loaded whole onto the AVM stack and decoded
  // by a consuming contract (see ARC87Reader.readPacked / readRecord).
  const packed = ABIType.from("(uint64,uint64)").encode([40n, 2n]);
  const cappedId = await deploy(
    algorand,
    deployer,
    "packed-struct",
    { packed },
    { maxValue: Number(MAX_STRUCT_SIZE) },
  );
  const cap = (await algorand.app.getGlobalState(cappedId)).maxValue?.value;
  assert.equal(BigInt(cap as bigint | number), MAX_STRUCT_SIZE, "maxValue");
  const stored = await fromBoxes<{ packed: Uint8Array }>(algorand, cappedId, {
    binary: ["packed"],
  });
  assert.deepEqual(stored.packed, packed, "PackedValue leaf round-trips");
  console.log(
    `\nCapped store ${cappedId}: maxValue = ${cap} bytes, PackedValue leaf = 0x${Buffer.from(packed).toString("hex")}`,
  );
} catch (e) {
  console.log("Ensure you have a localnet running and a wallet with funds.");
  console.error(e);
  process.exitCode = 1;
}
