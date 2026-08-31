from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release.yml"
GENERATE_PROVENANCE = ROOT / "typescript" / "scripts" / "generate-npm-attestation.mjs"
TYPESCRIPT_PACKAGE = ROOT / "typescript" / "package.json"


def _workflow_text() -> str:
    return RELEASE_WORKFLOW.read_text(encoding="utf-8")


def _jobs() -> dict[str, dict[str, Any]]:
    parsed = yaml.safe_load(_workflow_text())
    jobs = parsed.get("jobs")
    assert isinstance(jobs, dict)
    return jobs


def _step(job: dict[str, Any], name: str) -> dict[str, Any]:
    for step in job.get("steps", []):
        if step.get("name") == name:
            return step
    raise AssertionError(f"missing workflow step: {name}")


def _serialized(value: object) -> str:
    return json.dumps(value, sort_keys=True)


def test_release_guard_is_bound_to_the_canonical_repository_identity() -> None:
    guard = _step(
        _jobs()["build-and-verify"],
        "Verify immutable tag and coordinated versions",
    )
    assert guard["env"]["EXPECTED_REPOSITORY"] == ("Deng-m1/stripe-entitlements-fastapi")
    assert guard["env"]["EXPECTED_REPOSITORY_ID"] == "1346854294"
    assert guard["env"]["EXPECTED_REPOSITORY_OWNER_ID"] == "80449295"
    guard_text = guard["run"]
    required = [
        'test "$GITHUB_REPOSITORY" = "$EXPECTED_REPOSITORY"',
        'test "$ACTUAL_REPOSITORY_ID" = "$EXPECTED_REPOSITORY_ID"',
        'test "$ACTUAL_REPOSITORY_OWNER_ID" = "$EXPECTED_REPOSITORY_OWNER_ID"',
        'test "$(git cat-file -t "refs/tags/$GITHUB_REF_NAME")" = "tag"',
        "git merge-base --is-ancestor",
    ]
    for fragment in required:
        assert fragment in guard_text


def test_release_jobs_have_minimum_and_separated_permissions() -> None:
    jobs = _jobs()
    assert set(jobs) == {
        "build-and-verify",
        "npm-identity",
        "npm-bootstrap",
        "npm-verify",
        "container-publish",
        "container-attest",
        "finalize-release",
    }
    assert jobs["build-and-verify"]["permissions"] == {}
    assert jobs["npm-identity"]["permissions"] == {"id-token": "write"}
    assert jobs["npm-bootstrap"]["permissions"] == {}
    assert jobs["npm-verify"]["permissions"] == {}
    assert jobs["container-publish"]["permissions"] == {"packages": "write"}
    assert jobs["container-attest"]["permissions"] == {
        "attestations": "write",
        "id-token": "write",
        "packages": "write",
    }
    assert jobs["finalize-release"]["permissions"] == {
        "contents": "write",
        "packages": "write",
    }

    assert jobs["npm-identity"]["environment"] == "npm-publish"
    assert jobs["npm-bootstrap"]["environment"] == "npm-publish"
    assert jobs["finalize-release"]["environment"] == "npm-publish"
    assert "environment" not in jobs["container-attest"]
    for job_name, job in jobs.items():
        if job_name not in {"npm-identity", "container-attest"}:
            assert "id-token" not in job["permissions"]


def test_untrusted_build_and_verification_jobs_receive_no_release_secret() -> None:
    jobs = _jobs()
    for job_name in (
        "build-and-verify",
        "npm-identity",
        "npm-verify",
        "container-publish",
        "container-attest",
    ):
        text = _serialized(jobs[job_name])
        assert "secrets.NPM_TOKEN" not in text
        assert "NODE_AUTH_TOKEN" not in text
    assert "secrets.NPM_TOKEN" in _serialized(jobs["npm-bootstrap"])
    assert "secrets.NPM_TOKEN" in _serialized(jobs["finalize-release"])


def test_npm_publication_uses_candidate_tag_and_correct_provenance_mode() -> None:
    jobs = _jobs()
    registry_preflight = _step(jobs["build-and-verify"], "Preflight the npm registry destination")
    assert 'publish_tag="release-${RELEASE_VERSION//[^0-9A-Za-z]/-}"' in str(
        registry_preflight["run"]
    )

    oidc_publish = _step(
        jobs["npm-identity"], "Publish an existing npm package through trusted OIDC"
    )["run"]
    bootstrap_publish = _step(
        jobs["npm-bootstrap"],
        "Publish the first package with the pre-generated provenance",
    )["run"]
    for command in (oidc_publish, bootstrap_publish):
        assert " publish " in command
        assert '--tag "$PUBLISH_TAG"' in command
        assert "--ignore-scripts" in command
        assert "--provenance " not in command
    # Existing packages use npm Trusted Publisher, whose npm 11 OIDC exchange
    # automatically generates provenance. The token-only first publish cannot do
    # that, so it consumes the bundle signed in the clean identity job.
    assert "--provenance-file" not in oidc_publish
    assert "--provenance-file" in bootstrap_publish

    generation = _step(
        jobs["npm-identity"],
        "Generate the environment-bound npm provenance bundle",
    )["run"]
    assert '--environment "npm-publish"' in generation
    assert '--run-id "$GITHUB_RUN_ID"' in generation
    assert '--run-attempt "$GITHUB_RUN_ATTEMPT"' in generation


def test_brand_new_package_publish_can_resume_an_exact_unknown_result() -> None:
    step = _step(
        _jobs()["npm-bootstrap"],
        "Publish the first package with the pre-generated provenance",
    )
    script = step["run"]
    assert step["env"]["EXPECTED_INTEGRITY"] == (
        "${{ needs.build-and-verify.outputs.npm_integrity }}"
    )
    assert 'package_spec="${package_name}@${RELEASE_VERSION}"' in script
    assert 'existing_integrity="$(npm --userconfig=/dev/null view' in script
    assert '[ "$existing_integrity" != "$EXPECTED_INTEGRITY" ]' in script
    assert '"dist-tags.$PUBLISH_TAG"' in script
    assert 'test "$existing_candidate" = "$RELEASE_VERSION"' in script
    assert "already contains the exact bootstrap artifact" in script
    assert script.index("existing_integrity=") < script.index('node "$npm_cli" publish')
    assert script.index("could not re-confirm brand-new npm package vacancy") < script.index(
        "brand-new npm package requires the environment NPM_TOKEN secret"
    )
    assert script.index(
        "brand-new npm package requires the environment NPM_TOKEN secret"
    ) < script.index('node "$npm_cli" publish')
    assert "refusing token fallback" not in script


def test_registry_verification_binds_signature_to_environment_and_run() -> None:
    verification = _step(
        _jobs()["npm-verify"],
        "Verify the anonymous npm registry installation",
    )["run"]
    required_fragments = [
        'package_name="@tosea/stripe-entitlements"',
        "expected_attestation_url=",
        "https://registry.npmjs.org/-/npm/v1/attestations/@tosea%2fstripe-entitlements@",
        "audit signatures --prefix",
        "node typescript/scripts/verify-npm-attestation.mjs",
        '--package-name "$package_name"',
        '--version "$RELEASE_VERSION"',
        '--integrity "$EXPECTED_INTEGRITY"',
        '--commit "$EXPECTED_TAG_COMMIT"',
        '--tag "$GITHUB_REF_NAME"',
        '--repository "$EXPECTED_REPOSITORY"',
        '--repository-id "$EXPECTED_REPOSITORY_ID"',
        '--repository-owner-id "$EXPECTED_REPOSITORY_OWNER_ID"',
        '--workflow-path ".github/workflows/release.yml"',
        '--run-id "$GITHUB_RUN_ID"',
        '--run-attempt "$GITHUB_RUN_ATTEMPT"',
        '--environment "npm-publish"',
        '--attempt-policy "$attempt_policy"',
        "attempt_policy=exact",
        "attempt_policy=same-run-not-newer",
        'scripts/verify_npm_next_consumer.sh "$registry_archive"',
    ]
    for fragment in required_fragments:
        assert fragment in verification
    assert verification.index("audit signatures --prefix") < verification.index(
        "node typescript/scripts/verify-npm-attestation.mjs"
    )
    assert "verify_npm_provenance.py" not in _workflow_text()


def test_same_run_retry_policy_uses_the_build_attempt_checkpoint() -> None:
    workflow = _workflow_text()
    jobs = _jobs()
    assert "workflow_dispatch" not in workflow
    assert jobs["build-and-verify"]["outputs"]["build_attempt"] == (
        "${{ steps.transfer.outputs.run_attempt }}"
    )
    transfer = _step(jobs["build-and-verify"], "Stage byte-identified cross-job release artifacts")[
        "run"
    ]
    assert 'echo "run_attempt=$GITHUB_RUN_ATTEMPT"' in transfer
    verification = _step(jobs["npm-verify"], "Verify the anonymous npm registry installation")[
        "run"
    ]
    assert '[ "$BUILD_RUN_ATTEMPT" != "$GITHUB_RUN_ATTEMPT" ]' in verification
    assert "same-run-not-newer" in verification


def test_artifact_boundaries_are_manifest_verified_between_privilege_jobs() -> None:
    workflow = _workflow_text()
    jobs = _jobs()
    assert "release-package-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" in workflow
    assert "release-container-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" in workflow
    assert "release-assets-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" in workflow
    assert "npm-provenance-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" in workflow
    assert workflow.count("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02") == 4
    assert workflow.count("actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0") == 7
    for job_name in (
        "npm-identity",
        "npm-bootstrap",
        "npm-verify",
        "container-publish",
        "finalize-release",
    ):
        job_text = _serialized(jobs[job_name])
        assert "MANIFEST.sha256" in job_text
        assert "sha256sum --check" in job_text


def test_final_promotion_is_downstream_of_every_verification_gate() -> None:
    jobs = _jobs()
    final = jobs["finalize-release"]
    assert set(final["needs"]) == {
        "build-and-verify",
        "npm-verify",
        "container-publish",
        "container-attest",
    }
    final_names = [step.get("name") for step in final["steps"]]
    assert final_names.index("Upload or byte-verify every GitHub Release asset") < (
        final_names.index("Revalidate every remote candidate before channel promotion")
    )
    assert final_names.index(
        "Revalidate every remote candidate before channel promotion"
    ) < final_names.index("Determine moving-channel release policy")
    assert final_names.index("Determine moving-channel release policy") < (
        final_names.index("Promote and anonymously verify eligible OCI channels")
    )
    assert final_names.index(
        "Promote and anonymously verify eligible OCI channels"
    ) < final_names.index("Remove GHCR credentials before npm authority")
    assert final_names.index("Remove GHCR credentials before npm authority") < (
        final_names.index("Promote the verified npm candidate to latest")
    )
    assert final_names.index("Promote the verified npm candidate to latest") < (
        final_names.index("Publish the fully verified GitHub Release")
    )
    promotion = _step(final, "Promote the verified npm candidate to latest")
    credential_cleanup = _step(final, "Remove GHCR credentials before npm authority")
    assert "docker logout ghcr.io" in credential_cleanup["run"]
    assert "GHCR credential remains after logout" in credential_cleanup["run"]
    assert "secrets.NPM_TOKEN" not in _serialized(credential_cleanup)
    assert promotion["if"] == "steps.channel_policy.outputs.latest == 'true'"
    assert "secrets.NPM_TOKEN" in _serialized(promotion)
    assert "dist-tag add" in promotion["run"]


def test_oci_immutable_tags_are_retry_safe_and_channels_wait_for_attestation() -> None:
    jobs = _jobs()
    publication = jobs["container-publish"]
    publication_text = _serialized(publication)
    push = _step(publication, "Publish or resume immutable OCI tags")["run"]

    assert set(publication["outputs"]) == {"digest"}
    assert ":latest" not in push
    assert "${RELEASE_VERSION%.*}" not in push
    assert "candidate_image_id" in push
    assert "local registry" not in push
    assert "127.0.0.1:5000" not in push
    assert "release candidate must be one image manifest, not an index" in push
    assert "published candidate differs from the tested image" in push
    assert 'config.get("digest") != expected_config_digest' in push
    assert "--format '{{.Os}}/{{.Architecture}}'" in push
    assert '[ "$existing_digest" != "$candidate_digest" ]' in push
    assert "immutable OCI tags disagree" in push
    assert "refusing immutable OCI tag with a different digest" in push
    assert "already identifies the exact immutable candidate" in push
    assert "imagetools create --prefer-index=false" in push
    assert '"${CONTAINER_IMAGE}@${candidate_digest}"' in push
    assert 'if output="$(docker buildx imagetools inspect "$tag")"' in push
    assert 'DOCKER_CONFIG="$anonymous_config"' in push
    assert 'done < "$immutable_tags_file"' in push
    assert "moving-container-tags.txt" not in publication_text

    attestation = _step(jobs["container-attest"], "Attest the published container provenance")
    assert attestation["with"] == {
        "subject-name": "${{ needs.build-and-verify.outputs.container_image }}",
        "subject-digest": "${{ needs.container-publish.outputs.digest }}",
        "push-to-registry": True,
    }

    final = jobs["finalize-release"]
    policy = _step(final, "Determine moving-channel release policy")["run"]
    promotion = _step(final, "Promote and anonymously verify eligible OCI channels")["run"]
    verification = _step(final, "Revalidate every remote candidate before channel promotion")["run"]
    assert '"ls-remote"' in policy
    assert "https://github.com/Deng-m1/stripe-entitlements-fastapi.git" in policy
    assert "current >= max(released" in policy
    assert "version[:2] == current[:2]" in policy
    assert '"npm", "view", "@tosea/stripe-entitlements", "dist-tags"' in policy
    assert "workflow-wide concurrency group serializes every channel writer" in policy
    assert "inspect_channel_version" not in policy
    assert "GITHUB_OUTPUT" in policy
    assert policy.index("npm_latest") < policy.index("output.write")
    assert "imagetools create --prefer-index=false" in promotion
    assert '"${CONTAINER_IMAGE}@${CONTAINER_DIGEST}"' in promotion
    assert 'DOCKER_CONFIG="$anonymous_config"' in promotion
    assert 'if output="$(DOCKER_CONFIG="$anonymous_config"' in promotion
    assert ":latest" not in verification
    assert "${RELEASE_VERSION%.*}" not in verification
    assert "container-attest" in final["needs"]


def test_every_publication_boundary_revalidates_the_annotated_tag() -> None:
    jobs = _jobs()
    identity_check = _step(jobs["npm-identity"], "Revalidate the annotated publication tag")["run"]
    bootstrap_publish = _step(
        jobs["npm-bootstrap"],
        "Publish the first package with the pre-generated provenance",
    )["run"]
    container_check = _step(jobs["container-publish"], "Revalidate the annotated publication tag")[
        "run"
    ]
    final_check = _step(
        jobs["finalize-release"],
        "Revalidate the tag and reserve or resume this run's Release",
    )["run"]
    for script in (identity_check, bootstrap_publish, container_check, final_check):
        assert "git ls-remote --refs" in script
        assert 'test "$remote_tag_object" = "$EXPECTED_TAG_OBJECT"' in script


def test_exact_npm_cli_archive_and_generator_source_are_pinned() -> None:
    workflow = _workflow_text()
    generator = GENERATE_PROVENANCE.read_text(encoding="utf-8")
    assert "npm-11.19.1.tgz" in workflow
    assert (
        "sha512-ztsxKxt/kkIaAs+2i0GU6I+DRmUdrNasxTZKJe9TCdSjKxlhah/4r/"
        "hl5ygMD6XAg1qZ9c2TNomR4qgOydp10g=="
    ) in workflow
    assert 'const EXPECTED_NPM_VERSION = "11.19.1"' in generator
    assert '"ee9b1bc8e3f636fbaf5138a3e183ce3c6d42bb5dd57ab004578e534dd08da46b"' in generator
    assert '"9dda86510ab37e983839fcff81e72f4c1d789b67bafb086f41d18dbda81b95ec"' in generator
    assert 'tokenSubject: "1.3.6.1.4.1.57264.1.24"' in generator
    assert 'repo:${options.get("repository")}:environment:' in generator


def test_generator_rejects_release_tokens_before_reading_npm_sources(
    tmp_path: Path,
) -> None:
    node = shutil.which("node")
    assert node is not None
    repository = "Deng-m1/stripe-entitlements-fastapi"
    tag = "v0.4.0"
    commit = "a" * 40
    environment = {
        **os.environ,
        "GITHUB_ACTIONS": "true",
        "GITHUB_EVENT_NAME": "push",
        "GITHUB_REF": f"refs/tags/{tag}",
        "GITHUB_REPOSITORY": repository,
        "GITHUB_REPOSITORY_ID": "1346854294",
        "GITHUB_REPOSITORY_OWNER_ID": "80449295",
        "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_RUN_ID": "123456",
        "GITHUB_SHA": commit,
        "RUNNER_ENVIRONMENT": "github-hosted",
        "GITHUB_WORKFLOW_REF": (f"{repository}/.github/workflows/release.yml@refs/tags/{tag}"),
        "ACTIONS_ID_TOKEN_REQUEST_URL": "https://example.invalid/oidc",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "not-a-real-token",
        "NPM_TOKEN": "must-not-enter-identity-job",
    }
    environment.pop("NODE_AUTH_TOKEN", None)
    completed = subprocess.run(
        [
            node,
            str(GENERATE_PROVENANCE),
            "--package-name",
            "@tosea/stripe-entitlements",
            "--version",
            "0.4.0",
            "--integrity",
            "sha512-" + ("A" * 86) + "==",
            "--commit",
            commit,
            "--tag",
            tag,
            "--repository",
            repository,
            "--repository-id",
            "1346854294",
            "--repository-owner-id",
            "80449295",
            "--workflow-path",
            ".github/workflows/release.yml",
            "--run-id",
            "123456",
            "--run-attempt",
            "1",
            "--environment",
            "npm-publish",
            "--npm-root",
            str(tmp_path / "missing-npm"),
            "--output",
            str(tmp_path / "must-not-exist.json"),
        ],
        check=False,
        capture_output=True,
        env=environment,
        text=True,
    )
    assert completed.returncode == 1
    assert completed.stdout == ""
    assert completed.stderr == (
        "npm provenance generation NPM_TOKEN must not enter the identity job\n"
    )
    assert not (tmp_path / "must-not-exist.json").exists()


def test_sigstore_verifier_is_an_exact_dev_dependency_and_runs_in_check() -> None:
    package = json.loads(TYPESCRIPT_PACKAGE.read_text(encoding="utf-8"))
    # npm 11 treats publishConfig.provenance and --provenance-file as mutually
    # exclusive. The release workflow supplies one pre-generated, verified bundle.
    assert package["publishConfig"] == {"access": "public"}
    assert package["devDependencies"]["sigstore"] == "4.1.1"
    assert "npm run test:provenance" in package["scripts"]["check"]
    assert package["scripts"]["test:provenance"] == (
        "node --test scripts/verify-npm-attestation.test.mjs"
    )
