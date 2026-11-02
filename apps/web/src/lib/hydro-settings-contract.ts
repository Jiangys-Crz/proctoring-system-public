// Shared by the settings page and API to detect a stale page/server pairing.
export const HYDRO_SETTINGS_VERSION = '2026.10.08.2';
export type HydroConnectionSettings = { baseUrl: string; apiKey: string; problemDomainId: string };
export type HydroSettingsResponse = HydroConnectionSettings & { settingsVersion?: string };

export function publicHydroSettings(settings: HydroConnectionSettings): HydroSettingsResponse {
  return { baseUrl: settings.baseUrl, apiKey: settings.apiKey, problemDomainId: settings.problemDomainId, settingsVersion: HYDRO_SETTINGS_VERSION };
}
