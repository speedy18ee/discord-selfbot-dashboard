try {
    const ClientUserSettingManager = require("./node_modules/discord.js-selfbot-v13/src/managers/ClientUserSettingManager.js");
    if (ClientUserSettingManager && ClientUserSettingManager.prototype) {
        ClientUserSettingManager.prototype._patch = function(data) { return this; };
    }
} catch (e) {}

const { Client } = require("discord.js-selfbot-v13");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus } = require("@discordjs/voice");
const { FFmpeg } = require("prism-media");
const youtubedl = require("youtube-dl-exec");

const client = new Client({ checkUpdate: false });
const ACCOUNT_TOKEN = 'ur token';

let currentConnection = null;
const audioPlayer = createAudioPlayer();
let currentUrl = null;
let isBassboosted = false;
let currentVolumeMultiplier = 1.0;
let activeResource = null;
let currentChannelId = null;
let currentTitle = "Unknown";

// ─── LOUD MODE SETTINGS ───
let loudMode = false;
let loudModeBoost = 2.0;
let loudModeMaxVolume = 10.0;
let loudModeInterval = null;

// ─── VOICE SETTINGS ───
let echoCancellation = true;
let noiseSuppression = true;
let voiceMode = "default";

// ─── BLAST MODE ───
let blastMode = false;
let blastVolume = 50.0;

// ─── PUNGI MODE (EXTREME SNAKE CHARMER) ───
let pungiMode = false;
let pungiIntensity = 100.0; // 10000% default

// ─── LOOP FEATURE ───
let loopMode = false;

// ─── CHECK IF URL IS YOUTUBE ───
function isYouTubeUrl(url) {
    return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(url);
}

// ─── GET AUDIO URL (YouTube or direct) ───
async function getAudioUrl(url) {
    if (isYouTubeUrl(url)) {
        const result = await youtubedl(url, {
            dumpSingleJson: true,
            noPlaylist: true,
            format: 'bestaudio[ext=webm]/bestaudio/best',
            noWarnings: true
        });
        return {
            url: result.url,
            title: result.title || "YouTube Audio",
            isYouTube: true
        };
    } else {
        return {
            url: url,
            title: "Direct Stream",
            isYouTube: false
        };
    }
}

// ─── CREATE AUDIO RESOURCE ───
function createAudioResourceFromUrl(audioUrl, bassboosted, blast = false, pungi = false) {
    let finalStream = audioUrl;

    // Build audio filter chain
    let audioFilters = [];

    if (bassboosted) {
        audioFilters.push("equalizer=f=60:width_type=h:width=50:g=15");
    }

    if (pungi) {
        // PUNGI MODE: Snake charmer hypnotic destruction
        audioFilters.push("acrusher=bits=4:mode=log:aa=1"); // Bit crusher distortion
        audioFilters.push("equalizer=f=30:width_type=h:width=80:g=20"); // Sub-bass boost
        audioFilters.push("equalizer=f=100:width_type=h:width=100:g=15"); // Bass boost
        audioFilters.push("equalizer=f=1000:width_type=h:width=500:g=10"); // Mid boost
        audioFilters.push("equalizer=f=5000:width_type=h:width=2000:g=12"); // Treble boost
        audioFilters.push("loudnorm=I=-1:TP=0:LRA=1"); // Extreme compression
        audioFilters.push(`volume=${pungiIntensity}`); // Massive gain
        audioFilters.push("dynaudnorm=p=0.5:m=100.0:g=25"); // Aggressive normalization
        audioFilters.push("aphaser=0.8:0.8:2000:0.4"); // Phaser effect
        audioFilters.push("aecho=0.8:0.9:1000:0.3"); // Echo for hypnotic effect
    } else if (blast) {
        audioFilters.push("loudnorm=I=-5:TP=0:LRA=1");
        audioFilters.push("volume=20.0");
        audioFilters.push("dynaudnorm=p=0.9:m=50.0:g=15");
    } else {
        audioFilters.push("loudnorm");
    }

    const filterString = audioFilters.join(",");

    if (bassboosted || blast || pungi) {
        const ffmpeg = new FFmpeg({
            args: [
                "-reconnect", "1",
                "-reconnect_streamed", "1",
                "-reconnect_delay_max", "5",
                "-analyzeduration", "0",
                "-loglevel", "error",
                "-i", audioUrl,
                "-af", filterString,
                "-f", "s16le",
                "-ar", "48000",
                "-ac", "2"
            ],
            shell: false
        });
        finalStream = ffmpeg;
    }

    const resource = createAudioResource(finalStream, {
        inputType: (bassboosted || blast || pungi) ? StreamType.Raw : StreamType.Arbitrary,
        inlineVolume: true
    });

    // Set volume
    let vol;
    if (pungi) {
        vol = Math.min(pungiIntensity, 100.0);
    } else if (blast) {
        vol = Math.min(blastVolume, 100.0);
    } else {
        vol = currentVolumeMultiplier;
    }
    
    resource.volume.setVolume(vol);
    return resource;
}

// ─── PLAY AUDIO (with loop support) ───
async function playAudio(url, title, isYouTube) {
    if (!currentConnection) return;
    
    currentUrl = url;
    currentTitle = title;
    
    activeResource = createAudioResourceFromUrl(url, isBassboosted, blastMode, pungiMode);
    audioPlayer.play(activeResource);
    currentConnection.subscribe(audioPlayer);

    console.log(`[PLAYER] ▶️  Now playing: ${title}`);
    
    if (pungiMode) {
        console.log(`[PUNGI MODE] 🐍🎵 PUNGI SNAKE CHARMER ACTIVATED! 🎵🐍`);
        console.log(`[PUNGI MODE] Intensity: ${pungiIntensity}x (${Math.round(pungiIntensity * 100)}%)`);
        console.log(`[PUNGI MODE] Everyone will be hypnotized!`);
    } else if (blastMode) {
        console.log(`[BLAST MODE] 🔥 Intensity: ${Math.round(blastVolume * 100)}%`);
    }

    if (loudMode) {
        startLoudMode(currentConnection);
    }
}

// ─── SEND VOICE SETTINGS ───
async function updateVoiceSettings(guildId, channelId) {
    try {
        const shard = client.ws.shards.first();
        if (!shard) return;

        shard.send({
            op: 4,
            d: {
                guild_id: guildId,
                channel_id: channelId,
                self_mute: false,
                self_deaf: false,
                self_video: false,
            }
        });

        console.log(`[VOICE SETTINGS] Echo: ${echoCancellation ? "ON" : "OFF"} | Noise: ${noiseSuppression ? "ON" : "OFF"} | Mode: ${voiceMode}`);

    } catch (err) {
        console.error(`[VOICE SETTINGS ERROR] ${err.message}`);
    }
}

// ─── START LOUD MODE ───
function startLoudMode(connection) {
    if (loudModeInterval) clearInterval(loudModeInterval);
    
    console.log("[LOUD MODE] 🔊 Monitoring voice activity...");
    
    loudModeInterval = setInterval(() => {
        if (!connection || !activeResource || !loudMode) return;
        
        const channel = client.channels.cache.get(currentChannelId);
        if (!channel) return;
        
        const speakingMembers = channel.members.filter(m => {
            return m.id !== client.user.id && 
                   !m.voice.selfMute && 
                   m.voice.speaking;
        });
        
        if (speakingMembers.size > 0) {
            const newVolume = Math.min(
                currentVolumeMultiplier * loudModeBoost, 
                loudModeMaxVolume
            );
            
            if (activeResource.volume && activeResource.volume.volume !== newVolume) {
                activeResource.volume.setVolume(newVolume);
                console.log(`[LOUD MODE] 🔥 BOOSTING! Bot volume: ${Math.round(newVolume * 100)}%`);
            }
        } else {
            if (activeResource.volume && activeResource.volume.volume !== currentVolumeMultiplier) {
                activeResource.volume.setVolume(currentVolumeMultiplier);
                console.log(`[LOUD MODE] 📉 Normal volume: ${Math.round(currentVolumeMultiplier * 100)}%`);
            }
        }
    }, 500);
}

// ─── STOP LOUD MODE ───
function stopLoudMode() {
    if (loudModeInterval) {
        clearInterval(loudModeInterval);
        loudModeInterval = null;
    }
    loudMode = false;
    console.log("[LOUD MODE] ⛔ Disabled");
}

// ─── AUDIO PLAYER EVENTS ───
audioPlayer.on(AudioPlayerStatus.Playing, () => {
    console.log("[PLAYER] ▶️  Playing...");
    if (loudMode && currentConnection) {
        startLoudMode(currentConnection);
    }
});

audioPlayer.on(AudioPlayerStatus.Paused, () => {
    console.log("[PLAYER] ⏸️  Paused");
});

audioPlayer.on(AudioPlayerStatus.Idle, () => {
    console.log("[PLAYER] ⏹️  Stopped");
    
    // LOOP FEATURE: If loop is on, replay the song
    if (loopMode && currentUrl && currentConnection) {
        console.log("[LOOP] 🔄 Replaying: " + currentTitle);
        setTimeout(() => {
            playAudio(currentUrl, currentTitle, isYouTubeUrl(currentUrl));
        }, 500);
        return;
    }
    
    if (loudModeInterval) {
        clearInterval(loudModeInterval);
        loudModeInterval = null;
    }
});

audioPlayer.on("error", (error) => {
    console.error(`[PLAYER ERROR] ${error.message}`);
});

// ─── CONNECTION EVENTS ───
function attachConnectionEvents(connection) {
    connection.on(VoiceConnectionStatus.Ready, () => {
        console.log("[CONNECTION] ✅ Connected");
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log("[CONNECTION] ⚠️ Disconnected");
        currentConnection = null;
        currentChannelId = null;
        stopLoudMode();
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
        console.log("[CONNECTION] 💀 Destroyed");
        currentConnection = null;
        currentChannelId = null;
        stopLoudMode();
    });
}

// ─── READY ───
client.on("ready", async () => {
    console.log(`[SELF-BOT] Logged in as: ${client.user.tag}`);
    console.log("\n╔════════════════════════════════════════════════════╗");
    console.log("║  🐍 PUNGI SNAKE CHARMER BOT v3.0 🐍                ║");
    console.log("╠════════════════════════════════════════════════════╣");
    console.log("║  <channel-id>       → Join voice channel           ║");
    console.log("║  play <url>         → Play audio                   ║");
    console.log("║  pause / resume     → Control playback             ║");
    console.log("║  stop               → Stop                         ║");
    console.log("║  loop               → Toggle loop mode 🔄           ║");
    console.log("║  bassboost          → Toggle bass boost            ║");
    console.log("║  volume <1-10000>   → Set volume                   ║");
    console.log("║  blast              → Toggle Blast Mode 🔥          ║");
    console.log("║  blastset <1-100>   → Set blast intensity          ║");
    console.log("║  pungi              → 🐍 TOGGLE PUNGI MODE 🐍       ║");
    console.log("║  pungiset <1-200>   → Set pungi intensity          ║");
    console.log("║  loudmode           → Auto-boost when others speak ║");
    console.log("║  loudset <1-10>     → Loud mode multiplier        ║");
    console.log("║  echo / noise       → Toggle voice processing      ║");
    console.log("║  mode <type>        → Set voice mode               ║");
    console.log("║  leave              → Disconnect                   ║");
    console.log("╚════════════════════════════════════════════════════╝\n");

    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    process.stdin.on("data", async (text) => {
        const input = text.trim();
        if (!input) return;
        const lowerInput = input.toLowerCase();

        // ─── LOOP TOGGLE ───
        if (lowerInput === "loop") {
            loopMode = !loopMode;
            console.log(`[LOOP] 🔄 ${loopMode ? "ENABLED — Song will repeat forever!" : "Disabled"}`);
            return;
        }

        // ─── PUNGI MODE TOGGLE ───
        if (lowerInput === "pungi") {
            pungiMode = !pungiMode;
            blastMode = false; // Disable blast when pungi is on
            
            console.log(`[PUNGI MODE] ${pungiMode ? "🐍🎵 PUNGI SNAKE CHARMER ACTIVATED! 🎵🐍" : "⛔ Pungi mode off"}`);
            
            if (pungiMode) {
                console.log(`[PUNGI MODE] Intensity: ${pungiIntensity}x`);
                console.log(`[PUNGI MODE] Features: Bit Crusher + Sub-Bass + Echo + Phaser`);
                console.log(`[PUNGI MODE] Everyone will be hypnotized!`);
            }
            
            // Restart if playing
            if (activeResource && currentUrl && currentConnection) {
                console.log("[PUNGI MODE] Restarting with new settings...");
                try {
                    playAudio(currentUrl, currentTitle, isYouTubeUrl(currentUrl));
                } catch (e) {
                    console.error(`[PUNGI ERROR] ${e.message}`);
                }
            }
            return;
        }

        // ─── PUNGI INTENSITY SET ───
        if (lowerInput.startsWith("pungiset ")) {
            const val = parseFloat(input.slice(9).trim());
            if (isNaN(val) || val < 1 || val > 200) {
                return console.log("[ERROR] Pungi intensity must be 1-200 (200 = 20000%!)");
            }
            pungiIntensity = val;
            console.log(`[PUNGI MODE] Intensity: ${val}x (${Math.round(val * 100)}%)`);
            
            if (pungiMode && activeResource?.volume) {
                activeResource.volume.setVolume(val);
            }
            return;
        }

        // ─── BLAST MODE ───
        if (lowerInput === "blast") {
            blastMode = !blastMode;
            pungiMode = false; // Disable pungi when blast is on
            
            console.log(`[BLAST MODE] ${blastMode ? "🔥 EXTREME BLAST ENABLED!" : "⛔ Blast disabled"}`);
            
            if (blastMode) {
                console.log(`[BLAST MODE] Intensity: ${blastVolume}x`);
            }
            
            if (activeResource && currentUrl && currentConnection) {
                console.log("[BLAST MODE] Restarting with new settings...");
                try {
                    playAudio(currentUrl, currentTitle, isYouTubeUrl(currentUrl));
                } catch (e) {
                    console.error(`[BLAST ERROR] ${e.message}`);
                }
            }
            return;
        }

        // ─── BLAST VOLUME SET ───
        if (lowerInput.startsWith("blastset ")) {
            const val = parseFloat(input.slice(9).trim());
            if (isNaN(val) || val < 1 || val > 100) {
                return console.log("[ERROR] Blast intensity must be 1-100");
            }
            blastVolume = val;
            console.log(`[BLAST MODE] Intensity: ${val}x (${Math.round(val * 100)}%)`);
            
            if (blastMode && activeResource?.volume) {
                activeResource.volume.setVolume(val);
            }
            return;
        }

        // ─── ECHO CANCELLATION ───
        if (lowerInput === "echo") {
            echoCancellation = !echoCancellation;
            console.log(`[ECHO] Echo Cancellation: ${echoCancellation ? "✅ ON" : "❌ OFF"}`);
            if (currentConnection && currentChannelId) {
                const channel = client.channels.cache.get(currentChannelId);
                if (channel) await updateVoiceSettings(channel.guild.id, currentChannelId);
            }
            return;
        }

        // ─── NOISE SUPPRESSION ───
        if (lowerInput === "noise") {
            noiseSuppression = !noiseSuppression;
            console.log(`[NOISE] Noise Suppression: ${noiseSuppression ? "✅ ON" : "❌ OFF"}`);
            if (currentConnection && currentChannelId) {
                const channel = client.channels.cache.get(currentChannelId);
                if (channel) await updateVoiceSettings(channel.guild.id, currentChannelId);
            }
            return;
        }

        // ─── VOICE MODE ───
        if (lowerInput.startsWith("mode ")) {
            const mode = input.slice(5).trim().toLowerCase();
            const validModes = ["default", "none", "ptt", "voiceactivity", "va"];
            if (!validModes.includes(mode)) {
                console.log("[ERROR] Valid modes: default, none, ptt, voiceactivity (va)");
                return;
            }
            voiceMode = mode === "va" ? "voiceactivity" : mode;
            console.log(`[MODE] Voice Mode: ${voiceMode}`);
            if (currentConnection && currentChannelId) {
                const channel = client.channels.cache.get(currentChannelId);
                if (channel) await updateVoiceSettings(channel.guild.id, currentChannelId);
            }
            return;
        }

        // ─── LOUD MODE ───
        if (lowerInput === "loudmode") {
            loudMode = !loudMode;
            console.log(`[LOUD MODE] ${loudMode ? "🔥 ENABLED" : "⛔ Disabled"}`);
            if (loudMode && currentConnection && audioPlayer.state.status === AudioPlayerStatus.Playing) {
                startLoudMode(currentConnection);
            } else if (!loudMode) {
                stopLoudMode();
                if (activeResource?.volume) {
                    activeResource.volume.setVolume(currentVolumeMultiplier);
                }
            }
            return;
        }

        // ─── LOUD SET ───
        if (lowerInput.startsWith("loudset ")) {
            const boostVal = parseFloat(input.slice(8).trim());
            if (isNaN(boostVal) || boostVal < 1 || boostVal > 10) {
                return console.log("[ERROR] Boost must be 1-10");
            }
            loudModeBoost = boostVal;
            console.log(`[LOUD MODE] Boost: ${boostVal}x`);
            return;
        }

        if (lowerInput === "leave") {
            if (currentConnection) {
                stopLoudMode();
                audioPlayer.stop();
                currentConnection.destroy();
                activeResource = null;
                currentUrl = null;
                currentTitle = "Unknown";
                console.log("[CONNECTION] 👋 Left");
            } else {
                console.log("[ERROR] Not in a channel");
            }
            return;
        }

        if (lowerInput === "stop") {
            audioPlayer.stop();
            activeResource = null;
            console.log("[PLAYER] ⏹️ Stopped");
            return;
        }

        if (lowerInput === "pause") {
            if (audioPlayer.state.status === AudioPlayerStatus.Playing) {
                audioPlayer.pause();
            } else {
                console.log("[ERROR] Not playing");
            }
            return;
        }

        if (lowerInput === "resume") {
            if (audioPlayer.state.status === AudioPlayerStatus.Paused) {
                audioPlayer.unpause();
            } else {
                console.log("[ERROR] Not paused");
            }
            return;
        }

        // ─── VOLUME ───
        if (lowerInput.startsWith("volume ")) {
            const vol = parseInt(input.slice(7).trim(), 10);
            if (isNaN(vol) || vol < 1 || vol > 10000) {
                return console.log("[ERROR] Volume must be 1-10000");
            }
            currentVolumeMultiplier = vol / 100;
            console.log(`[VOLUME] Set to ${vol}% ${vol > 1000 ? "🔥🔥🔥" : vol > 500 ? "🔥🔥" : vol > 100 ? "🔥" : ""}`);
            
            if (activeResource?.volume) {
                activeResource.volume.setVolume(currentVolumeMultiplier);
            }
            return;
        }

        if (lowerInput === "bassboost") {
            if (!currentConnection || !currentUrl) {
                return console.log("[ERROR] Play something first");
            }
            isBassboosted = !isBassboosted;
            console.log(`[BASSBOOST] ${isBassboosted ? "ON" : "OFF"} — Restart to apply`);
            return;
        }

        // ─── PLAY ───
        if (lowerInput.startsWith("play ")) {
            const audioUrl = input.slice(5).trim();
            
            if (!audioUrl.startsWith('http')) {
                return console.log("[ERROR] Please provide a valid URL");
            }

            if (!currentConnection) {
                return console.log("[ERROR] Join a voice channel first");
            }

            const type = isYouTubeUrl(audioUrl) ? "YouTube" : "Direct Audio";
            console.log(`[PLAYER] ⏳ Fetching ${type} stream...`);

            try {
                const { url, title, isYouTube } = await getAudioUrl(audioUrl);
                await playAudio(url, title, isYouTube);

            } catch (err) {
                console.error(`[ERROR] ${err.message}`);
                if (isYouTubeUrl(audioUrl)) {
                    console.log("[TIP] Make sure yt-dlp is installed: pkg install yt-dlp");
                }
            }
            return;
        }

        // ─── JOIN VOICE CHANNEL ───
        const cleanId = input.replace(/[^\d]/g, "");
        if (!cleanId || cleanId.length < 10) {
            return console.log("[ERROR] Unknown command");
        }

        try {
            const channel = await client.channels.fetch(cleanId);
            if (!channel?.isVoice()) {
                return console.log("[ERROR] Not a voice channel");
            }

            if (currentConnection) {
                audioPlayer.stop();
                currentConnection.destroy();
            }

            currentConnection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfMute: false,
                selfDeaf: false
            });

            attachConnectionEvents(currentConnection);
            currentChannelId = channel.id;

            const shard = client.ws.shards.first();
            if (shard) {
                shard.send({
                    op: 4,
                    d: {
                        guild_id: channel.guild.id,
                        channel_id: channel.id,
                        self_mute: false,
                        self_deaf: false,
                        self_video: false
                    }
                });
            }

            await updateVoiceSettings(channel.guild.id, channel.id);

            console.log(`[CONNECTION] ✅ Joined: ${channel.name}`);

        } catch (err) {
            console.error(`[JOIN ERROR] ${err.message}`);
        }
    });
});

client.login(ACCOUNT_TOKEN);
