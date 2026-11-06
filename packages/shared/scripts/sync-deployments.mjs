// Mirrors contracts/deployments.json into packages/shared/src/deployments.json
import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(resolve(here, "../../../contracts/deployments.json"), resolve(here, "../src/deployments.json"));
console.log("mirrored deployments.json");
