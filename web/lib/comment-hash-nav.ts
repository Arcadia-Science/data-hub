import { isCommentHash } from "@/lib/comment-hash";

export function scrollToCommentHash(hash = window.location.hash): boolean {
  if (!isCommentHash(hash)) {
    return false;
  }
  const el = document.getElementById(hash.slice(1));
  if (!el) {
    return false;
  }
  el.scrollIntoView({ block: "center" });
  return true;
}

// App Router `push` / `<Link>` use history.pushState and do not fire
// `hashchange`, so a same-pathname `#comment-{id}` click would never
// scroll. Handle that case before the router sees it.
export function applySamePageCommentHash(href: string): boolean {
  const url = new URL(href, window.location.origin);
  if (!isCommentHash(url.hash) || url.pathname !== window.location.pathname) {
    return false;
  }
  if (url.hash === window.location.hash) {
    scrollToCommentHash(url.hash);
  } else {
    window.history.pushState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
  return true;
}

const SETTLE_MS = 4000;

// Comments sit below a streaming run-detail Suspense boundary. The first
// `scrollIntoView` can run while that block is still a skeleton; when the
// real files / plate map land, they push the comment out of view. Re-scroll
// on document resizes until the page settles, unless the user scrolls away.
export function subscribeCommentHashScroll(): () => void {
  let userMoved = false;

  const tryScroll = () => {
    if (!userMoved) {
      scrollToCommentHash();
    }
  };

  const onHashChange = () => {
    userMoved = false;
    tryScroll();
  };

  const onUserMoved = () => {
    userMoved = true;
  };

  tryScroll();
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("wheel", onUserMoved, { passive: true });
  window.addEventListener("touchmove", onUserMoved, { passive: true });

  const resizeObserver = new ResizeObserver(tryScroll);
  resizeObserver.observe(document.documentElement);
  const stopResize = window.setTimeout(() => {
    resizeObserver.disconnect();
  }, SETTLE_MS);

  return () => {
    resizeObserver.disconnect();
    window.clearTimeout(stopResize);
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("wheel", onUserMoved);
    window.removeEventListener("touchmove", onUserMoved);
  };
}
