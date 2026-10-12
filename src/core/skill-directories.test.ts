import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveSkillDirectories } from "./skill-directories.js";

describe("resolveSkillDirectories", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to process-shared skills when an Agent-scoped root is missing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-skill-roots-"));
    roots.push(cwd);
    const skillsBase = path.join(cwd, ".siclaw", "skills");
    const sharedResolved = path.join(skillsBase, "resolved");
    const scopedResolved = path.join(skillsBase, "agents", "qa-agent", "resolved");
    fs.mkdirSync(sharedResolved, { recursive: true });

    expect(resolveSkillDirectories({
      cwd,
      skillsBase,
      scopedSkillsDir: scopedResolved,
      includeBundledSkills: false,
      includePlatformSkills: false,
    })).toEqual([]);
  });

  it("loads only the Agent-scoped root when both scoped and shared skills exist", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-skill-roots-"));
    roots.push(cwd);
    const skillsBase = path.join(cwd, ".siclaw", "skills");
    const sharedResolved = path.join(skillsBase, "resolved");
    const scopedResolved = path.join(skillsBase, "agents", "qa-agent", "resolved");
    fs.mkdirSync(sharedResolved, { recursive: true });
    fs.mkdirSync(scopedResolved, { recursive: true });

    expect(resolveSkillDirectories({
      cwd,
      skillsBase,
      scopedSkillsDir: scopedResolved,
      includeBundledSkills: false,
      includePlatformSkills: false,
    })).toEqual([scopedResolved]);
  });

  it("preserves the pod-local resolved root when no scoped source is supplied", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-skill-roots-"));
    roots.push(cwd);
    const skillsBase = path.join(cwd, ".siclaw", "skills");
    const resolved = path.join(skillsBase, "resolved");
    fs.mkdirSync(resolved, { recursive: true });

    expect(resolveSkillDirectories({
      cwd,
      skillsBase,
      includeBundledSkills: false,
      includePlatformSkills: false,
    })).toEqual([resolved]);
  });

  it("keeps authorized baked Skills when a pod-local bundle exists", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-skill-roots-"));roots.push(cwd);
    const skillsBase = path.join(cwd, ".siclaw", "skills"), resolved = path.join(skillsBase, "resolved");
    const core = path.join(cwd, "skills", "core"), extension = path.join(cwd, "skills", "extension");
    for (const dir of [resolved, core, extension]) fs.mkdirSync(dir, { recursive: true });
    expect(resolveSkillDirectories({ cwd, skillsBase, includeBundledSkills: true, includePlatformSkills: false }))
      .toEqual([resolved, core, extension]);
  });

  it("adds only authorized image roots when the Agent-scoped bundle is missing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-skill-roots-"));roots.push(cwd);
    const skillsBase = path.join(cwd, ".siclaw", "skills"), shared = path.join(skillsBase, "resolved"),
      scoped = path.join(skillsBase, "agents", "agent-a", "resolved"), core = path.join(cwd, "skills", "core");
    for (const dir of [shared, core]) fs.mkdirSync(dir, { recursive: true });
    expect(resolveSkillDirectories({ cwd, skillsBase, scopedSkillsDir: scoped, includeBundledSkills: true, includePlatformSkills: false }))
      .toEqual([core]);
    expect(resolveSkillDirectories({ cwd, skillsBase, scopedSkillsDir: scoped, includeBundledSkills: false, includePlatformSkills: false }))
      .toEqual([]);
  });
});
