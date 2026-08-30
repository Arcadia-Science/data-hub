export function dataHubOrigin(): string {
  const meta = document.querySelector('meta[name="data-hub-origin"]');
  const content = meta?.getAttribute("content")?.replace(/\/$/, "") ?? "";
  if (content && !content.includes("%%")) {
    return content;
  }
  return "";
}

export function runDetailUrl(instrumentId: string, runId: string): string {
  const origin = dataHubOrigin();
  const path = `/instruments/${encodeURIComponent(instrumentId)}/runs/${encodeURIComponent(runId)}`;
  return origin ? `${origin}${path}` : path;
}
