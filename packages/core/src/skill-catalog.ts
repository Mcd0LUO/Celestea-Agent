/**
 * W884 — the skill CATALOG: the "resident" half of progressive disclosure.
 *
 * W882 owns discovery + the frontmatter contract; the tool (`load_skill`) owns
 * the body-on-demand half. This module owns the third piece: the compact,
 * name + description ONLY listing that is injected into the conversation at
 * every turn start. The body is NEVER here.
 *
 * Cost rules (the whole point of the split):
 *   - ZERO rows when the workspace declares no skill (a workspace without
 *     skills pays nothing);
 *   - a description longer than [SKILL_CATALOG_DESCRIPTION_MAX] is truncated
 *     (W879);
 *   - at most [SKILL_CATALOG_MAX] entries, name-sorted (the listing already is),
 *     with the omitted count stated so a truncation is never silent.
 */

import type { CelesteaHomeInput } from "./celestea-home.js";
import { readLayers } from "./celestea-sources.js";
import { listSkills, nodeSkillIo, type SkillDefinition, type SkillIo, type SkillListing } from "./skills.js";

/** Maximum number of skills the injected catalog lists. */
export const SKILL_CATALOG_MAX = 32;
/** Maximum description length inside the catalog, in characters (W879). */
export const SKILL_CATALOG_DESCRIPTION_MAX = 200;

/** The catalog header: how to load a body, and what is deliberately absent. */
const CATALOG_HEADER =
  "Skills available in this workspace (call the load_skill tool with a name to load one's full instructions before doing a task it covers; a skill's own files — references/, scripts/ — are NOT inlined, read them yourself with read_file):";

/** Truncate on a code-point boundary and mark the cut. */
function clip(text: string): string {
  const chars = [...text];
  if (chars.length <= SKILL_CATALOG_DESCRIPTION_MAX) return text;
  return chars.slice(0, SKILL_CATALOG_DESCRIPTION_MAX).join("") + "…";
}

function catalogLine(skill: SkillDefinition): string {
  return "- " + skill.name + ": " + clip(skill.description);
}

/**
 * Render the catalog text of one discovery listing. PURE. Returns `null` when
 * there is nothing to announce, so the caller injects NOTHING (zero cost).
 */
export function renderSkillCatalog(listing: SkillListing): string | null {
  if (listing.skills.length === 0) return null;
  const shown = listing.skills.slice(0, SKILL_CATALOG_MAX);
  const lines = [CATALOG_HEADER, ...shown.map(catalogLine)];
  const omitted = listing.skills.length - shown.length;
  if (omitted > 0) lines.push("- (+" + omitted + " more skills not listed; the listing is name-sorted)");
  return lines.join("\n");
}

/** Discover the two layers of `wsPath` and render their catalog (or null). */
export function skillCatalogOf(wsPath: string, input: CelesteaHomeInput = {}, io: SkillIo = nodeSkillIo): string | null {
  return renderSkillCatalog(listSkills(readLayers(wsPath, input), io));
}
