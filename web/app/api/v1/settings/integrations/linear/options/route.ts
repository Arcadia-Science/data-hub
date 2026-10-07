import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import {
  apiError,
  LINEAR_UNAVAILABLE,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import {
  LinearRequestError,
  listLinearTeamOptions,
  listLinearTeams,
} from "@/lib/linear/client";
import { getLinearCredentials } from "@/lib/linear/config";

export async function GET(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const credentials = await getLinearCredentials();
  if (!credentials) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "Save a Linear client ID and client secret first."
    );
  }

  const teamId = new URL(request.url).searchParams.get("team_id");

  try {
    const teams = await listLinearTeams(credentials);
    if (!teamId) {
      return Response.json({ teams, projects: null, labels: null });
    }
    const options = await listLinearTeamOptions(credentials, teamId);
    if (!options) {
      return apiError(404, NOT_FOUND, "That Linear team was not found.");
    }
    return Response.json({
      teams,
      projects: options.projects,
      labels: options.labels,
    });
  } catch (err) {
    if (err instanceof LinearRequestError) {
      return apiError(502, LINEAR_UNAVAILABLE, err.message);
    }
    throw err;
  }
}
