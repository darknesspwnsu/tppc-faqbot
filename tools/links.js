// tools/links.js
//
// Tool-ish link commands.

export function registerLinks(register) {
  register(
    "!organizer",
    async ({ message }) => {
      await message.reply(
        "https://coldsp33d.github.io/box_organizer\nTip: You can also use `/sortbox` for in-bot sorting."
      );
    },
    "!organizer — returns the organizer page link (try /sortbox for in-bot sorting)",
    { aliases: ["!boxorganizer"] }
  );

  register(
    "!tools",
    async ({ message }) => {
      await message.reply("https://wiki.tppc.info/TPPC_Tools_and_Calculators");
    },
    "!tools — returns a wiki link to several helpful TPPC tools, calculators and other utilties."
  );
}
