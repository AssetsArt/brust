// Usage: bun scripts/bun-codegen.ts <path-to-bun-checkout>
// Regenerates bun-codegen/{json,xml}_byte_class.{rs,h} with Bun's own generators.
// Run only when bumping the Bun rev (docs/design/bun-rev-bump.md). Output is committed.
import { resolve } from "node:path";

const bunSrc = process.argv[2];
if (!bunSrc) {
  console.error("usage: bun scripts/bun-codegen.ts <path-to-bun-checkout>");
  process.exit(2);
}
const codegenDir = resolve(import.meta.dir, "..", "bun-codegen");
const { generateJsonByteClass } = await import(resolve(bunSrc, "scripts/build/jsonByteClass.ts"));
const { generateXmlByteClass } = await import(resolve(bunSrc, "scripts/build/xmlByteClass.ts"));
console.log(generateJsonByteClass({ codegenDir }));
console.log(generateXmlByteClass({ codegenDir }));
