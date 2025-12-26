// toybox.js
function targetUserId(message) {
  const first = message.mentions?.users?.first?.();
  return first?.id ?? message.author.id;
}
function mention(id) {
  return `<@${id}>`;
}

export function registerToybox(register) {
  register(
    "!rig",
    async ({ message }) => {
      const uid = targetUserId(message);
      await message.channel.send(`${mention(uid)} has now been blessed by rngesus.`);
    },
    "!rig — bless someone with RNG"
  );
}
