/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SkillSearchMenu } from "./SkillSearchMenu";
import {
  filterSkillItems,
  type SkillSearchItem,
} from "./skill-search-filter";

const SKILLS: SkillSearchItem[] = [
  { id: "1", name: "deep-research", description: "Research the web deeply" },
  { id: "2", name: "guizang-ppt-skill", description: "生成横向翻页网页 PPT" },
];

describe("filterSkillItems", () => {
  it("matches on name (case-insensitive substring)", () => {
    expect(filterSkillItems(SKILLS, "DEEP").map((s) => s.id)).toEqual(["1"]);
  });

  it("matches on description", () => {
    expect(filterSkillItems(SKILLS, "翻页").map((s) => s.id)).toEqual(["2"]);
  });

  it("returns every skill for an empty query (the bare `/` discovery case)", () => {
    expect(filterSkillItems(SKILLS, "")).toHaveLength(2);
  });

  it("returns nothing for a slash command that is not a skill name", () => {
    // ``/compact`` etc. — the composer treats these as pass-through commands.
    expect(filterSkillItems(SKILLS, "compact")).toEqual([]);
  });
});

describe("SkillSearchMenu", () => {
  it("renders nothing when no skill matches (no dead-end empty state)", () => {
    const { container } = render(
      <SkillSearchMenu
        skills={SKILLS}
        query="compact"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists matching skills", () => {
    const { getByText } = render(
      <SkillSearchMenu
        skills={SKILLS}
        query="deep"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(getByText("deep-research")).toBeTruthy();
  });
});
