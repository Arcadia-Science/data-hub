import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <HomeLayout
      // Fumadocs' header has no option for these, so they target its markup:
      // no line under the header, and side padding that matches the page's.
      className="[&_#nd-nav>div]:border-b-0 [&_#nd-nav_nav]:px-6 sm:[&_#nd-nav_nav]:px-8"
      {...baseOptions()}
    >
      {children}
    </HomeLayout>
  );
}
