import { getModelProviderData } from "../models.ts";
import { ModelProviderName, ModelClass } from "../types.ts";
import { describe, test, expect, vi } from "vitest";

// Mock settings
vi.mock("../settings", () => {
    return {
        default: {
            SMALL_OPENROUTER_MODEL: "mock-small-model",
            LARGE_OPENROUTER_MODEL: "mock-large-model",
            OPENROUTER_MODEL: "mock-default-model",
            OPENAI_API_KEY: "mock-openai-key",
            ANTHROPIC_API_KEY: "mock-anthropic-key",
            OPENROUTER_API_KEY: "mock-openrouter-key",
            ETERNALAI_MODEL: "mock-eternal-model",
            ETERNALAI_URL: "https://mock.eternal.ai",
            LLAMACLOUD_MODEL_SMALL: "mock-llama-small",
            LLAMACLOUD_MODEL_LARGE: "mock-llama-large",
            TOGETHER_MODEL_SMALL: "mock-together-small",
            TOGETHER_MODEL_LARGE: "mock-together-large",
        },
        loadEnv: vi.fn(),
    };
});

describe("Model Provider Configuration", () => {
    describe("OpenAI Provider", () => {
        test("should have correct endpoint", async () => {
            expect((await getModelProviderData(ModelProviderName.OPENAI)).endpoint).toBe("https://api.openai.com/v1");
        });

        test("should have correct model mappings", async () => {
            const openAIModels = (await getModelProviderData(ModelProviderName.OPENAI)).model;
            expect(openAIModels[ModelClass.SMALL]).toBe("gpt-4o-mini");
            expect(openAIModels[ModelClass.MEDIUM]).toBe("gpt-4o");
            expect(openAIModels[ModelClass.LARGE]).toBe("gpt-4o");
            expect(openAIModels[ModelClass.EMBEDDING]).toBe("text-embedding-3-small");
            expect(openAIModels[ModelClass.IMAGE]).toBe("dall-e-3");
        });

        test("should have correct settings configuration", async () => {
            const settings = (await getModelProviderData(ModelProviderName.OPENAI)).settings;
            expect(settings.maxInputTokens).toBe(128000);
            expect(settings.maxOutputTokens).toBe(8192);
            expect(settings.temperature).toBe(0.6);
            expect(settings.frequency_penalty).toBe(0.0);
            expect(settings.presence_penalty).toBe(0.0);
        });
    });

    describe("Anthropic Provider", () => {
        test("should have correct endpoint", async () => {
            expect((await getModelProviderData(ModelProviderName.ANTHROPIC)).endpoint).toBe("https://api.anthropic.com/v1");
        });

        test("should have correct model mappings", async () => {
            const anthropicModels = (await getModelProviderData(ModelProviderName.ANTHROPIC)).model;
            expect(anthropicModels[ModelClass.SMALL]).toBe("claude-3-haiku-20240307");
            expect(anthropicModels[ModelClass.MEDIUM]).toBe("claude-3-5-sonnet-20241022");
            expect(anthropicModels[ModelClass.LARGE]).toBe("claude-3-5-sonnet-20241022");
        });

        test("should have correct settings configuration", async () => {
            const settings = (await getModelProviderData(ModelProviderName.ANTHROPIC)).settings;
            expect(settings.maxInputTokens).toBe(200000);
            expect(settings.maxOutputTokens).toBe(4096);
            expect(settings.temperature).toBe(0.7);
            expect(settings.frequency_penalty).toBe(0.4);
            expect(settings.presence_penalty).toBe(0.4);
        });
    });

    describe("LlamaCloud Provider", () => {
        test("should have correct endpoint", async () => {
            expect((await getModelProviderData(ModelProviderName.LLAMACLOUD)).endpoint).toBe("https://api.llamacloud.com/v1");
        });

        test("should have correct model mappings", async () => {
            const llamaCloudModels = (await getModelProviderData(ModelProviderName.LLAMACLOUD)).model;
            expect(llamaCloudModels[ModelClass.SMALL]).toBe("meta-llama/Llama-3.2-3B-Instruct-Turbo");
            expect(llamaCloudModels[ModelClass.MEDIUM]).toBe("meta-llama-3.1-8b-instruct");
            expect(llamaCloudModels[ModelClass.LARGE]).toBe("meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo");
            expect(llamaCloudModels[ModelClass.EMBEDDING]).toBe("togethercomputer/m2-bert-80M-32k-retrieval");
            expect(llamaCloudModels[ModelClass.IMAGE]).toBe("black-forest-labs/FLUX.1-schnell");
        });

        test("should have correct settings configuration", async () => {
            const settings = (await getModelProviderData(ModelProviderName.LLAMACLOUD)).settings;
            expect(settings.maxInputTokens).toBe(128000);
            expect(settings.maxOutputTokens).toBe(8192);
            expect(settings.temperature).toBe(0.7);
            expect(settings.repetition_penalty).toBe(0.4);
        });
    });

    describe("Google Provider", () => {
        test("should have correct model mappings", async () => {
            const googleModels = (await getModelProviderData(ModelProviderName.GOOGLE)).model;
            expect(googleModels[ModelClass.SMALL]).toBe("gemini-1.5-flash-latest");
            expect(googleModels[ModelClass.MEDIUM]).toBe("gemini-1.5-flash-latest");
            expect(googleModels[ModelClass.LARGE]).toBe("gemini-1.5-pro-latest");
        });
    });
});

describe("Model Retrieval Functions", () => {
    describe("getModelProviderData function", () => {
        test("should retrieve correct models for different providers and classes", async () => {
            expect((await getModelProviderData(ModelProviderName.OPENAI)).model[ModelClass.SMALL]).toBe("gpt-4o-mini");
            expect((await getModelProviderData(ModelProviderName.ANTHROPIC)).model[ModelClass.LARGE]).toBe("claude-3-5-sonnet-20241022");
            expect((await getModelProviderData(ModelProviderName.LLAMACLOUD)).model[ModelClass.MEDIUM]).toBe("meta-llama-3.1-8b-instruct");
        });

        test("should handle environment variable overrides", async () => {
            expect((await getModelProviderData(ModelProviderName.OPENROUTER)).model[ModelClass.SMALL]).toBe("mock-small-model");
            expect((await getModelProviderData(ModelProviderName.OPENROUTER)).model[ModelClass.LARGE]).toBe("mock-large-model");
            expect((await getModelProviderData(ModelProviderName.ETERNALAI)).model[ModelClass.SMALL]).toBe("mock-eternal-model");
        });

        test("should throw error for invalid model provider", async () => {
            await expect(getModelProviderData("INVALID_PROVIDER" as any)).rejects.toThrow();
        });

        test("should retrieve correct endpoints for different providers", async () => {
            expect((await getModelProviderData(ModelProviderName.OPENAI)).endpoint).toBe("https://api.openai.com/v1");
            expect((await getModelProviderData(ModelProviderName.ANTHROPIC)).endpoint).toBe("https://api.anthropic.com/v1");
            expect((await getModelProviderData(ModelProviderName.LLAMACLOUD)).endpoint).toBe("https://api.llamacloud.com/v1");
            expect((await getModelProviderData(ModelProviderName.ETERNALAI)).endpoint).toBe("https://mock.eternal.ai");
        });
    });
});

describe("Model Settings Validation", () => {
    test("all providers should have required settings", () => {
        Object.values(ModelProviderName).forEach(async provider => {
            const providerConfig = await getModelProviderData(provider);
            expect(providerConfig.settings).toBeDefined();
            expect(providerConfig.settings.maxInputTokens).toBeGreaterThan(0);
            expect(providerConfig.settings.maxOutputTokens).toBeGreaterThan(0);
            expect(providerConfig.settings.temperature).toBeDefined();
        });
    });

    test("all providers should have model mappings for basic model classes", () => {
        Object.values(ModelProviderName).forEach(async provider => {
            const providerConfig = await getModelProviderData(provider);
            expect(providerConfig.model).toBeDefined();
            expect(providerConfig.model[ModelClass.SMALL]).toBeDefined();
            expect(providerConfig.model[ModelClass.MEDIUM]).toBeDefined();
            expect(providerConfig.model[ModelClass.LARGE]).toBeDefined();
        });
    });
});

describe("Environment Variable Integration", () => {
    test("should use environment variables for LlamaCloud models", async () => {
        const llamaConfig = await getModelProviderData(ModelProviderName.LLAMACLOUD);
        expect(llamaConfig.model[ModelClass.SMALL]).toBe("meta-llama/Llama-3.2-3B-Instruct-Turbo");
        expect(llamaConfig.model[ModelClass.LARGE]).toBe("meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo");
    });

    test("should use environment variables for Together models", async () => {
        const togetherConfig = await getModelProviderData(ModelProviderName.TOGETHER);
        expect(togetherConfig.model[ModelClass.SMALL]).toBe("meta-llama/Llama-3.2-3B-Instruct-Turbo");
        expect(togetherConfig.model[ModelClass.LARGE]).toBe("meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo");
    });
});
