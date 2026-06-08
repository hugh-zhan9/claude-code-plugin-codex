import assert from "node:assert/strict";
import test from "node:test";
import { taskPermission } from "../scripts/lib/permissions.mjs";

test("taskPermission returns read-only when readOnly is set", () => {
  assert.equal(taskPermission({ readOnly: true }), "read-only");
});

test("taskPermission defaults to workspace-write", () => {
  assert.equal(taskPermission({}), "workspace-write");
  assert.equal(taskPermission({ readOnly: false }), "workspace-write");
});
