import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { DataHubLogo } from "@/components/data-hub-logo";
import { appName, docsRoute, gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      url: docsRoute,
      title: (
        <>
          <DataHubLogo className="size-5" />
          {appName}
        </>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
