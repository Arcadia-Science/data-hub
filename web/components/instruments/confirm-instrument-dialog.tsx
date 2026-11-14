"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ReactElement,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { ConfirmReviewSummary } from "@/components/instruments/confirm-review-summary";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type InstrumentType, VALID_INSTRUMENT_TYPES } from "@/lib/db/schema";
import {
  buildConfirmInstrumentBody,
  type InstrumentConfirmReview,
} from "@/lib/instruments/confirm-review";
import { INSTRUMENT_TYPE_LABELS } from "@/lib/instruments/instrument-type-labels";

const INSTRUMENT_TYPE_OPTIONS = VALID_INSTRUMENT_TYPES.map((value) => ({
  value,
  label: INSTRUMENT_TYPE_LABELS[value],
}));

const TYPE_REASON_ID = "confirm-instrument-type-reason";
const LOAD_ERROR = "Couldn't load the watcher's settings.";

/**
 * Confirms a pending instrument. `children` is the button that opens the
 * dialog, so Radix returns focus to it when the dialog closes. The admin reviews
 * the watcher's settings and picks the instrument type, then one request makes
 * the instrument active with that type. The review loads each time it opens.
 */
export function ConfirmInstrumentDialog({
  children,
  displayName,
  instrumentId,
}: {
  children: ReactElement;
  displayName: string;
  instrumentId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<InstrumentConfirmReview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [instrumentType, setInstrumentType] = useState<InstrumentType | "">("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const typeTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    setReview(null);
    setLoadError(null);
    setInstrumentType("");
    setSubmitError(null);
    fetch(
      `/api/v1/instruments/${encodeURIComponent(instrumentId)}/confirm-review`,
      { signal: controller.signal }
    )
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Request failed with ${res.status}`);
        }
        return res.json() as Promise<InstrumentConfirmReview>;
      })
      .then(setReview)
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadError(LOAD_ERROR);
        }
      });
    return () => controller.abort();
  }, [open, instrumentId]);

  const canConfirm = instrumentType !== "" && !isPending;
  const reason =
    instrumentType === "" ? "Choose an instrument type to confirm." : null;

  function handleConfirm() {
    if (instrumentType === "" || isPending) {
      return;
    }
    const body = buildConfirmInstrumentBody(instrumentType);
    startTransition(async () => {
      setSubmitError(null);
      try {
        const res = await fetch(
          `/api/v1/instruments/${encodeURIComponent(instrumentId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setSubmitError(data?.error ?? "Failed to confirm instrument");
          return;
        }
      } catch {
        setSubmitError("Failed to confirm instrument");
        return;
      }

      toast.success("Instrument confirmed");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="sm:max-w-[600px]"
        onOpenAutoFocus={(event) => {
          // Start on the type picker, the one choice the admin has to make.
          event.preventDefault();
          typeTriggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Confirm {displayName}?</DialogTitle>
          <DialogDescription>
            Once confirmed, the watcher starts uploading files from this folder.
            Check that this is what you expect.
          </DialogDescription>
        </DialogHeader>

        <p className="text-muted-foreground text-sm">
          ID <span className="font-mono text-foreground">{instrumentId}</span>
          {" · can't be changed later"}
        </p>

        {loadError ? (
          <p className="text-destructive text-sm" role="alert">
            {loadError}
          </p>
        ) : review ? (
          <ConfirmReviewSummary review={review} />
        ) : (
          <p className="text-muted-foreground text-sm" role="status">
            Loading…
          </p>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="confirm-instrument-type">Instrument type</Label>
          <Select
            onValueChange={(value) =>
              setInstrumentType(value as InstrumentType)
            }
            value={instrumentType}
          >
            <SelectTrigger
              className="w-full"
              id="confirm-instrument-type"
              ref={typeTriggerRef}
            >
              <SelectValue placeholder="Choose a type" />
            </SelectTrigger>
            <SelectContent>
              {INSTRUMENT_TYPE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            Decides how files are processed and which details appear on run
            pages.
          </p>
          {reason ? (
            <p className="text-muted-foreground text-xs" id={TYPE_REASON_ID}>
              {reason}
            </p>
          ) : null}
        </div>

        {submitError ? (
          <p className="text-destructive text-sm" role="alert">
            {submitError}
          </p>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <Link
            className="w-fit font-medium text-foreground underline underline-offset-[3px]"
            href={`/instruments/${encodeURIComponent(instrumentId)}/watcher/settings`}
          >
            Change settings first
          </Link>
          <div className="flex gap-2">
            <Button
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              aria-describedby={reason ? TYPE_REASON_ID : undefined}
              aria-disabled={canConfirm ? undefined : true}
              onClick={handleConfirm}
              type="button"
            >
              {isPending ? <Loader2 className="animate-spin" /> : null}
              Confirm instrument
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
