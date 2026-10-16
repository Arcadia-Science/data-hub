/**
 * Builds the URL for a pagination link. Page 1 drops the param, matching how
 * `PaginationNav` clears it from the address bar, so both paths produce the
 * same URL. Other query params stay in place so filters survive the click.
 */
export function buildPageHref(
  pathname: string,
  currentParams: URLSearchParams | string,
  pageParam: string,
  targetPage: number
): string {
  const params = new URLSearchParams(currentParams);
  if (targetPage <= 1) {
    params.delete(pageParam);
  } else {
    params.set(pageParam, String(targetPage));
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
