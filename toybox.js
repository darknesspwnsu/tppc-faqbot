function targetUser(message) {
  return message.mentions?.users?.first?.() ?? null;
}

function mention(id) {
  return `<@${id}>`;
}

export function registerToybox(register) {
  register(
    "!rig",
    async ({ message }) => {
      const uid = message.mentions?.users?.first?.()?.id ?? message.author.id;
      await message.channel.send(`${mention(uid)} has now been blessed by rngesus.`);
    },
    "!rig — bless someone with RNG"
  );

  register(
    "!curse",
    async ({ message }) => {
      const target = targetUser(message);

      // Must target someone
      if (!target) {
        await message.reply("You must curse someone else (mention a user).");
        return;
      }

      // Cannot curse yourself
      if (target.id === message.author.id) {
        await message.reply("You can't curse yourself. Why would you want to do that?");
        return;
      }

      await message.channel.send(
        `${mention(target.id)} is now cursed by rngesus.`
      );
    },
    "!curse @user — curse someone with anti-RNG"
  );
}
