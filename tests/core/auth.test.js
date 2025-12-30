import { describe, it, expect, vi, afterEach } from "vitest";
import { PermissionsBitField } from "discord.js";

const originalEnv = { ...process.env };

async function loadAuthModule({ fileContents, throws = false } = {}) {
  vi.resetModules();

  const readFileSync = vi.fn(() => {
    if (throws) throw new Error("no file");
    return fileContents ?? "{}";
  });

  vi.doMock("fs", () => ({ default: { readFileSync }, readFileSync }));

  const mod = await import("../../auth.js");
  return { ...mod, readFileSync };
}

function makeMessage({
  guildId = "g1",
  authorId = "u1",
  admin = false,
  manageGuild = false,
} = {}) {
  return {
    guildId,
    author: { id: authorId },
    member: {
      permissions: {
        has: (flag) => {
          if (admin && flag === PermissionsBitField.Flags.Administrator) return true;
          if (manageGuild && flag === PermissionsBitField.Flags.ManageGuild) return true;
          return false;
        },
      },
    },
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

describe("auth.js", () => {
  it("treats admin or manage guild as adminish", async () => {
    const { isAdminOrPrivileged } = await loadAuthModule({
      fileContents: JSON.stringify({ g1: [] }),
    });

    const adminMsg = makeMessage({ admin: true });
    expect(isAdminOrPrivileged(adminMsg)).toBe(true);

    const manageMsg = makeMessage({ manageGuild: true });
    expect(isAdminOrPrivileged(manageMsg)).toBe(true);
  });

  it("grants privileged users per guild list", async () => {
    const { isAdminOrPrivileged } = await loadAuthModule({
      fileContents: JSON.stringify({ g1: ["u1"], g2: ["u2"] }),
    });

    const msg = makeMessage({ guildId: "g1", authorId: "u1" });
    expect(isAdminOrPrivileged(msg)).toBe(true);

    const other = makeMessage({ guildId: "g1", authorId: "u3" });
    expect(isAdminOrPrivileged(other)).toBe(false);
  });

  it("handles missing privileged_users.json by treating list as empty", async () => {
    const { isAdminOrPrivileged } = await loadAuthModule({ throws: true });

    const msg = makeMessage({ guildId: "g1", authorId: "u1" });
    expect(isAdminOrPrivileged(msg)).toBe(false);
  });
});
