const fs = require('fs');
const readline = require('readline');

async function main() {
  const fileStream = fs.createReadStream('C:\\Users\\pradyumna\\.gemini\\antigravity\\brain\\db91e82e-24d3-4b9a-bf8b-d05aaf0dd118\\.system_generated\\logs\\transcript.jsonl');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);
      if (obj.step_index === 2023) {
        console.log(obj.content);
      }
    } catch (e) {}
  }
}
main();
