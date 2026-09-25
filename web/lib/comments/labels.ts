import { firstName, possessive } from "@/lib/display-name";

export function writtenByLabel(displayName: string, isSelf: boolean): string {
  return isSelf ? "Written by you" : `Written by ${firstName(displayName)}`;
}

export function writtenByEmptyLabel(
  displayName: string,
  isSelf: boolean
): string {
  return isSelf
    ? "You haven't written any comments yet."
    : `${firstName(displayName)} hasn't written any comments yet.`;
}

export function onRunsLabel(displayName: string, isSelf: boolean): string {
  return isSelf ? "On your runs" : `On ${possessive(displayName)} runs`;
}

export function onRunsEmptyLabel(displayName: string, isSelf: boolean): string {
  return isSelf
    ? "No comments on your runs yet."
    : `No comments on ${possessive(displayName)} runs yet.`;
}
