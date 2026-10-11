import { YamlTestSchema } from "@uefn-devtools/test";
import { z } from "zod";

/** JSON schema for one YAML test document, as editors should validate it (input side: defaults are optional). Draft 7, which the Red Hat YAML extension supports fully. */
export async function yamlTestJsonSchema() {
  const schema = z.toJSONSchema(YamlTestSchema, { target: "draft-7", io: "input", unrepresentable: "any" });
  return {
    ...schema,
    // The runner silently drops unknown top-level keys; flag them in the editor so a typo
    // such as `step:` does not quietly skip every step.
    additionalProperties: false,
    title: "UEFN DevTools YAML test",
    description: "One test per YAML document (separate several tests with ---). See docs/tests.md.",
  };
}
