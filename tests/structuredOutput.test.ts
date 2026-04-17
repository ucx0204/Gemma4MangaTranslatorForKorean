import { describe, expect, it } from "vitest";
import { buildPolishResponseFormat, buildTranslationResponseFormat } from "../src/main/llm/structuredOutput";

describe("structured output schemas", () => {
  it("builds translation schemas with exact required ids", () => {
    const schema = buildTranslationResponseFormat(["b1", "b2"]);
    expect(schema).toEqual({
      type: "json_object",
      schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        title: "translation_payload",
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "object",
            additionalProperties: false,
            required: ["b1", "b2"],
            properties: {
              b1: {
                type: "string",
                minLength: 1,
                description: "Korean text for b1"
              },
              b2: {
                type: "string",
                minLength: 1,
                description: "Korean text for b2"
              }
            }
          }
        }
      }
    });
  });

  it("builds separate polish schemas for global g-ids", () => {
    const schema = buildPolishResponseFormat(["g1"]);
    expect(schema.schema).toMatchObject({
      title: "polish_payload",
      properties: {
        items: {
          required: ["g1"]
        }
      }
    });
  });
});
