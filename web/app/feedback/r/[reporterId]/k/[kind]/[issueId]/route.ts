import { type NextRequest, NextResponse } from "next/server";

// Linear stores this URL on the feedback issue. Opening it lands on the
// report in Data Hub. The path also lets Data Hub find one person's reports
// by searching Linear for the URL.
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ issueId: string }> }
) {
  const { issueId } = await context.params;
  const destination = new URL("/settings/feedback", request.url);
  destination.searchParams.set("item", issueId);
  return NextResponse.redirect(destination);
}
