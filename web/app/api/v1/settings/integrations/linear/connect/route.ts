import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  INTERNAL_ERROR,
  LINEAR_CLIENT_CREDENTIALS_OFF,
  LINEAR_CREDENTIALS_REJECTED,
  LINEAR_UNAVAILABLE,
} from "@/lib/api/errors";
import { readJsonBody } from "@/lib/api/openapi";
import { IntegrationSecretsKeyError } from "@/lib/crypto/integration-secrets";
import {
  LinearClientCredentialsError,
  LinearRequestError,
  testLinearConnection,
} from "@/lib/linear/client";
import {
  connectLinearApp,
  LinearWorkspaceChangeError,
  linearConnectBodySchema,
} from "@/lib/linear/config";
import { linearConfigResponse } from "../route";

// Checks the credentials with Linear before anything is saved, so a bad
// secret cannot replace a working one.
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = await readJsonBody(request, linearConnectBodySchema);
  if (body instanceof Response) {
    return body;
  }

  let organization: Awaited<ReturnType<typeof testLinearConnection>>;
  try {
    organization = await testLinearConnection({
      clientId: body.client_id,
      clientSecret: body.client_secret,
    });
  } catch (err) {
    if (err instanceof LinearClientCredentialsError) {
      return apiError(400, LINEAR_CLIENT_CREDENTIALS_OFF, err.message);
    }
    if (err instanceof LinearRequestError) {
      const rejected = err.message.startsWith(
        "Linear rejected the app credentials"
      );
      return apiError(
        rejected ? 400 : 502,
        rejected ? LINEAR_CREDENTIALS_REJECTED : LINEAR_UNAVAILABLE,
        err.message
      );
    }
    throw err;
  }

  try {
    const config = await connectLinearApp({
      clientId: body.client_id,
      clientSecret: body.client_secret,
      confirmWorkspaceChange: body.confirm_workspace_change === true,
      organization,
      updatedBy: authResult.userId,
    });
    return Response.json(linearConfigResponse(config));
  } catch (err) {
    if (err instanceof LinearWorkspaceChangeError) {
      return apiError(
        409,
        CONFLICT,
        `These credentials belong to ${err.workspaceName}. Connecting clears the team, project, labels, and signing secret.`,
        { workspace_id: err.workspaceId, workspace_name: err.workspaceName }
      );
    }
    if (err instanceof IntegrationSecretsKeyError) {
      return apiError(500, INTERNAL_ERROR, err.message);
    }
    throw err;
  }
}
