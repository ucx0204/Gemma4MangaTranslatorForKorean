type JsonSchema = Record<string, unknown>;

export type ChatResponseFormat = {
  type: "json_object";
  schema: JsonSchema;
};

export function buildTranslationResponseFormat(modelIds: string[]): ChatResponseFormat {
  return buildIdMapResponseFormat("translation_payload", modelIds);
}

export function buildPolishResponseFormat(modelIds: string[]): ChatResponseFormat {
  return buildIdMapResponseFormat("polish_payload", modelIds);
}

function buildIdMapResponseFormat(schemaName: string, modelIds: string[]): ChatResponseFormat {
  const itemProperties = Object.fromEntries(
    modelIds.map((modelId) => [
      modelId,
      {
        type: "string",
        minLength: 1,
        description: `Korean text for ${modelId}`
      }
    ])
  );

  return {
    type: "json_object",
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: schemaName,
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "object",
          additionalProperties: false,
          required: modelIds,
          properties: itemProperties
        }
      }
    }
  };
}
