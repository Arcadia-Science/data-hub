"use client";

import { X } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useTablePending } from "@/components/table-pending";
import { commentsSearchParams } from "@/lib/search-params";

const legendClassName =
  "mb-1.5 p-0 font-semibold text-[13px] text-muted-foreground";

const optionClassName = "flex h-9 cursor-pointer items-center gap-2.5 text-sm";

export function CommentFilterPanel({
  currentUserId,
  instruments,
  personLabel,
}: {
  currentUserId: string;
  instruments: { count: number; displayName: string; id: string }[];
  personLabel: string | null;
}) {
  const { startTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(commentsSearchParams, {
    shallow: false,
    startTransition,
  });

  const scope =
    filters.author === null
      ? filters.ran_by === currentUserId
        ? "mine"
        : filters.ran_by === null
          ? "all"
          : null
      : null;

  function selectScope(next: "all" | "mine") {
    const ranBy = next === "mine" ? currentUserId : null;
    if (filters.author === null && filters.ran_by === ranBy) {
      return;
    }
    setFilters({ author: null, page: 1, ran_by: ranBy });
  }

  function toggleInstrument(id: string) {
    const selected = filters.instrument_id.includes(id)
      ? filters.instrument_id.filter((value) => value !== id)
      : [...filters.instrument_id, id];
    setFilters({ instrument_id: selected, page: 1 });
  }

  return (
    <div className="flex flex-col gap-7">
      {personLabel === null ? null : (
        <fieldset className="m-0 flex flex-col border-0 p-0">
          <legend className={legendClassName}>Filtered</legend>
          <button
            aria-label={`Remove filter: ${personLabel}`}
            className="inline-flex h-9 w-fit items-center gap-2 text-sm"
            onClick={() => setFilters({ author: null, page: 1, ran_by: null })}
            type="button"
          >
            <span>{personLabel}</span>
            <X aria-hidden="true" className="size-3.5 text-muted-foreground" />
          </button>
        </fieldset>
      )}
      <fieldset className="m-0 flex flex-col border-0 p-0">
        <legend className={legendClassName}>Show</legend>
        <label className={optionClassName}>
          <input
            checked={scope === "all"}
            className="m-0 size-4 accent-foreground"
            name="comments-scope"
            onChange={() => selectScope("all")}
            type="radio"
          />
          <span>All comments</span>
        </label>
        <label className={optionClassName}>
          <input
            checked={scope === "mine"}
            className="m-0 size-4 accent-foreground"
            name="comments-scope"
            onChange={() => selectScope("mine")}
            type="radio"
          />
          <span>Comments on my runs</span>
        </label>
      </fieldset>
      {instruments.length > 0 ? (
        <fieldset className="m-0 flex flex-col border-0 p-0">
          <legend className={legendClassName}>Instrument</legend>
          {instruments.map((instrument) => (
            <label className={optionClassName} key={instrument.id}>
              <input
                checked={filters.instrument_id.includes(instrument.id)}
                className="m-0 size-4 shrink-0 accent-foreground"
                onChange={() => toggleInstrument(instrument.id)}
                type="checkbox"
              />
              <span className="min-w-0 flex-1 truncate">
                {instrument.displayName}
              </span>
              <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
                {instrument.count}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
