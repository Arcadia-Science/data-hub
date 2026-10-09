"use client";

import type { ReactNode } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export function CatalogSchemaAccordion({ children }: { children: ReactNode }) {
  return <Accordion multiple>{children}</Accordion>;
}

export function CatalogSchemaAccordionItem({
  children,
  title,
  value,
}: {
  children: ReactNode;
  title: string;
  value: string;
}) {
  return (
    <AccordionItem value={value}>
      <AccordionTrigger className="text-fd-muted-foreground text-xs uppercase tracking-wide hover:no-underline">
        {title}
      </AccordionTrigger>
      <AccordionContent>{children}</AccordionContent>
    </AccordionItem>
  );
}
