import { setBaseUrl as setClientBaseUrl } from "@workspace/api-client-react";

export function getApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_BASE_URL;
  if (envUrl && typeof envUrl === "string" && envUrl.trim().length > 0) {
    return envUrl.replace(/\/+$/, "");
  }
  return "";
}

export function initApiConfig() {
  const baseUrl = getApiBaseUrl();
  if (baseUrl) {
    setClientBaseUrl(baseUrl);
  }
}

export function getApiUrl(path: string): string {
  const baseUrl = getApiBaseUrl();
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (cleanPath.startsWith("http://") || cleanPath.startsWith("https://")) {
    return cleanPath;
  }
  return `${baseUrl}${cleanPath}`;
}

export function getWsUrl(path: string = "/api/ws"): string {
  const baseUrl = getApiBaseUrl();
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (baseUrl) {
    const wsProto = baseUrl.startsWith("https") ? "wss:" : "ws:";
    const host = baseUrl.replace(/^https?:\/\//, "");
    return `${wsProto}//${host}${cleanPath}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${cleanPath}`;
}
