module.exports = {
	name: 'volume', 
    aliases:['v'],
	description: 'Set Music Volume!',
    player: true,
    inVoiceChannel: true,
    sameVoiceChannel: true,
    owner: true,
	async execute(message,args) 
    {
        const player = message.client.manager.get(message.guild.id);
        if (!args[0]) return message.reply({ content: "**Please provide volume limit (1-1000)!**" }).then(msg =>
            { 
            setTimeout(() => { 
                msg.delete() 
            }, 2000)
            });
        const vol = parseInt(args[0], 10);
        player.setVolume(vol);
        try {
            if (player.node && player.node.rest) {
                const volMultiplier = Math.max(0.1, vol / 100.0);
                await player.node.rest.updatePlayer({
                    guildId: message.guild.id,
                    data: {
                        volume: Math.min(1000, vol),
                        filters: {
                            volume: volMultiplier,
                            channelMix: vol > 150 ? { leftToLeft: 1.5, leftToRight: 1.0, rightToLeft: 1.0, rightToRight: 1.5 } : null
                        }
                    }
                });
            }
        } catch (e) {}
        return message.reply({ content: `✅ Volume set to **${vol}%** ${vol >= 500 ? "🔥🔥🔥 EXTREME LOUD!" : "🔊"}` }).then(msg =>
            { 
            setTimeout(() => { 
                msg.delete() 
            }, 3000)
            });
	},
};
