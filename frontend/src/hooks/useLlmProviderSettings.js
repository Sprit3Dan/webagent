import { useCallback, useMemo } from "react";
import { CONTEXT } from "../lib/constants";
import {
  readPersistedLlmProviderSettings,
  writePersistedLlmProviderSettings,
} from "../lib/skillMemory";

function buildDefaultProvider(providerId, index = 0) {
  return {
    id: providerId,
    name: `provider-${index + 1}`,
    provider: "openai-compatible",
    baseUrl: "",
    model: String(CONTEXT.model || "nemotron-30b"),
    contextWindowTokens: Number(CONTEXT.contextWindowTokens || 64_000),
    tokenBudget: 0,
    tokenSecret: "",
  };
}

export default function useLlmProviderSettings({
  llmProviders = [],
  setLlmProviders,
  activeLlmProviderId = "",
  setActiveLlmProviderId,
  activeLlmProvider = null,
  setStatus,
} = {}) {
  const selectedLlmProvider = useMemo(() => {
    const providers = Array.isArray(llmProviders) ? llmProviders : [];
    if (!providers.length) return null;

    return (
      providers.find(
        (provider) =>
          String(provider?.id || "") === String(activeLlmProviderId || ""),
      ) ||
      activeLlmProvider ||
      providers[0]
    );
  }, [activeLlmProvider, activeLlmProviderId, llmProviders]);

  const initializeLlmProviders = useCallback(async () => {
    const persisted = await readPersistedLlmProviderSettings();
    const persistedProviders = Array.isArray(persisted?.providers)
      ? persisted.providers
      : [];

    if (persistedProviders.length) {
      setLlmProviders?.(persistedProviders);
      setActiveLlmProviderId?.(
        String(persisted?.activeProviderId || persistedProviders[0]?.id || ""),
      );
      return true;
    }

    return false;
  }, [setActiveLlmProviderId, setLlmProviders]);

  const updateActiveLlmProvider = useCallback(
    (patch = {}) => {
      const targetId = String(
        activeLlmProviderId ||
          (Array.isArray(llmProviders) && llmProviders.length
            ? llmProviders[0]?.id
            : ""),
      );

      setLlmProviders?.((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        return list.map((provider) =>
          String(provider?.id || "") === targetId
            ? { ...provider, ...patch }
            : provider,
        );
      });
    },
    [activeLlmProviderId, llmProviders, setLlmProviders],
  );

  const addLlmProvider = useCallback(() => {
    const existing = Array.isArray(llmProviders) ? llmProviders : [];
    const providerId = `provider-${Date.now()}`;
    const nextProvider = buildDefaultProvider(providerId, existing.length);

    setLlmProviders?.((prev) => [
      ...(Array.isArray(prev) ? prev : []),
      nextProvider,
    ]);
    setActiveLlmProviderId?.(providerId);
  }, [llmProviders, setActiveLlmProviderId, setLlmProviders]);

  const removeLlmProvider = useCallback(
    (providerId) => {
      const list = Array.isArray(llmProviders) ? llmProviders : [];
      if (list.length <= 1) return;

      const targetId = String(providerId || activeLlmProviderId || "");
      const filtered = list.filter(
        (provider) => String(provider?.id || "") !== targetId,
      );
      if (!filtered.length) return;

      setLlmProviders?.(filtered);

      if (String(activeLlmProviderId || "") === targetId) {
        setActiveLlmProviderId?.(String(filtered[0]?.id || ""));
      }
    },
    [activeLlmProviderId, llmProviders, setActiveLlmProviderId, setLlmProviders],
  );

  const saveLlmSettings = useCallback(async () => {
    try {
      await writePersistedLlmProviderSettings({
        providers: llmProviders,
        activeProviderId: activeLlmProviderId,
      });
      setStatus?.("settings: saved");
    } catch (err) {
      setStatus?.(
        `settings: save failed · ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }
  }, [activeLlmProviderId, llmProviders, setStatus]);

  return {
    selectedLlmProvider,
    initializeLlmProviders,
    updateActiveLlmProvider,
    addLlmProvider,
    removeLlmProvider,
    saveLlmSettings,
  };
}