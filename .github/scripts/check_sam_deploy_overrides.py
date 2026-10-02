"""Run both `sam deploy` commands offline to catch parameter overrides SAM rejects.

SAM validates `--parameter-overrides` before it calls AWS; an empty `AlarmEmail=`
once broke every deploy that way. This runs the CI deploy step and `make
sam-deploy` with dummy credentials and every AWS endpoint pointed at a closed
local port, so a command that passes SAM's own checks fails only on connecting.
"""

from __future__ import annotations
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-lambda.yml"
DEPLOY_STEP = "Deploy SAM stack"
CONNECT_ERROR = "Could not connect to the endpoint URL"

_ACCOUNT = "123456789012"
_REGISTRY = f"{_ACCOUNT}.dkr.ecr.us-west-1.amazonaws.com"

# ALARM_EMAIL is the only value the docs allow to be empty, so it stays empty.
WORKFLOW_VALUES = {
    "github.ref_name": "staging",
    "steps.ecr-login.outputs.registry": _REGISTRY,
    "secrets.SAM_S3_BUCKET": "offline-check-bucket",
    "secrets.DATA_HUB_API_URL": "https://example.com/api/v1",
    "secrets.DATA_HUB_API_KEY": "offline-check",
    "secrets.GH_OIDC_PROVIDER_ARN": f"arn:aws:iam::{_ACCOUNT}:oidc-provider/github",
    "secrets.VERCEL_OIDC_PROVIDER_ARN": f"arn:aws:iam::{_ACCOUNT}:oidc-provider/vercel",
    "vars.ADMIN_DEPLOY_PRINCIPAL_ARN": f"arn:aws:iam::{_ACCOUNT}:role/admin",
    "vars.ENABLE_S3_FILES": "false",
    "vars.ALARM_EMAIL": "",
}

MAKE_VALUES = {
    "ENV": "staging",
    "ECR_IMAGE_URI": f"{_REGISTRY}/data-hub-staging:offline-check",
    "DATA_HUB_API_URL": "https://example.com/api/v1",
    "DATA_HUB_API_KEY": "offline-check",
    "GITHUB_OIDC_PROVIDER_ARN": f"arn:aws:iam::{_ACCOUNT}:oidc-provider/github",
    "VERCEL_OIDC_PROVIDER_ARN": f"arn:aws:iam::{_ACCOUNT}:oidc-provider/vercel",
    "ADMIN_DEPLOY_PRINCIPAL_ARN": f"arn:aws:iam::{_ACCOUNT}:role/admin",
    "ENABLE_S3_FILES": "false",
    "ALARM_EMAIL": "",
}

_EXPRESSION = re.compile(r"\$\{\{\s*([^}]+?)\s*\}\}")


def _offline_env(home: str) -> dict[str, str]:
    return {
        "PATH": os.environ["PATH"],
        "HOME": home,
        "AWS_ACCESS_KEY_ID": "offline-check",
        "AWS_SECRET_ACCESS_KEY": "offline-check",
        "AWS_DEFAULT_REGION": "us-west-1",
        "AWS_CONFIG_FILE": os.devnull,
        "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
        "AWS_ENDPOINT_URL": "http://127.0.0.1:9",
        "AWS_EC2_METADATA_DISABLED": "true",
        "AWS_MAX_ATTEMPTS": "1",
        "SAM_CLI_TELEMETRY": "0",
        "IMAGE_URI": f"{_REGISTRY}/data-hub-staging:offline-check",
    }


def _workflow_script() -> tuple[str, Path]:
    workflow = yaml.safe_load(WORKFLOW.read_text())
    for job in workflow["jobs"].values():
        for step in job["steps"]:
            if step.get("name") == DEPLOY_STEP:
                cwd = REPO_ROOT / step.get("working-directory", ".")
                return _fill_expressions(step["run"]), cwd
    raise SystemExit(f"No step named {DEPLOY_STEP!r} in {WORKFLOW}")


def _fill_expressions(script: str) -> str:
    def _value(match: re.Match[str]) -> str:
        expression = match.group(1)
        if expression not in WORKFLOW_VALUES:
            raise SystemExit(
                f"Add a stand-in value for `{expression}` to WORKFLOW_VALUES in {__file__}."
            )
        return WORKFLOW_VALUES[expression]

    return _EXPRESSION.sub(_value, script)


def _check(label: str, command: list[str], cwd: Path, env: dict[str, str]) -> bool:
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=300)
    output = result.stdout + result.stderr
    if result.returncode != 0 and CONNECT_ERROR in output:
        print(f"ok: {label} got past SAM's checks and stopped at the AWS call.")
        return True
    print(f"FAILED: {label} stopped before calling AWS (exit {result.returncode}).")
    print(output)
    return False


def main() -> int:
    script, cwd = _workflow_script()
    with tempfile.TemporaryDirectory() as home:
        env = _offline_env(home)
        workflow_ok = _check(
            "deploy-lambda.yml",
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
            cwd,
            env,
        )
        make_args = [f"{name}={value}" for name, value in MAKE_VALUES.items()]
        make_ok = _check(
            "make sam-deploy",
            ["make", "-s", "sam-deploy", *make_args],
            REPO_ROOT,
            env,
        )
    return 0 if workflow_ok and make_ok else 1


if __name__ == "__main__":
    sys.exit(main())
