# pi-telegram

A Telegram bridge plugin for [pi](https://github.com/nicepkg/pi) that allows you to interact with your pi coding agent via Telegram messages.

## Features

- **Bidirectional communication**: Send messages to pi and receive responses via Telegram
- **Typing indicator**: Shows "typing..." animation while pi is processing
- **Thinking block filtering**: Automatically filters out AI thinking blocks from responses
- **Auto-start on boot**: Supports macOS (launchd) and Linux (systemd) for automatic startup
- **RPC mode**: Communicates with pi via RPC for reliable message handling

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [pi](https://github.com/nicepkg/pi) installed and built
- A Telegram bot token (create one via [@BotFather](https://t.me/BotFather))

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/iamcheyan/pi-telegram.git
   cd pi-telegram
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create configuration file:
   ```bash
   cp telegram-config.example.json telegram-config.json
   ```

4. Edit `telegram-config.json` with your bot token and chat ID:
   ```json
   {
     "botToken": "YOUR_BOT_TOKEN_HERE",
     "chatId": "YOUR_CHAT_ID_HERE"
   }
   ```

   To get your chat ID, send a message to [@userinfobot](https://t.me/userinfobot) on Telegram.

## Usage

### Manual Start

```bash
npm start
```

### Using with pi Extension

1. Link the extension to pi:
   ```bash
   ln -s $(pwd)/telegram-notify.ts ~/.pi/agent/extensions/telegram-notify.ts
   ```

2. Start pi and use the `/tg` command:
   ```
   /tg
   ```

   This will show the Telegram management menu with options to:
   - View bot status
   - Send test messages
   - Restart bridge service
   - Stop bridge service
   - View bridge logs
   - Check configuration

### Auto-start on Boot

The plugin supports automatic startup on system boot:

- **macOS**: Uses launchd service
- **Linux**: Uses systemd service

To enable auto-start, use the `/tg` command in pi and select "Restart Bridge Service".

## Configuration

### telegram-config.json

```json
{
  "botToken": "YOUR_BOT_TOKEN_HERE",
  "chatId": "YOUR_CHAT_ID_HERE"
}
```

- `botToken`: Your Telegram bot token from @BotFather
- `chatId`: Your Telegram user ID (not the bot's ID)

### Environment Variables

- `HOME`: Used for finding nvm and configuration files

## Architecture

```
Telegram User
    ↓
Telegram Bot API
    ↓
telegram-bridge.ts (long polling)
    ↓
PiRpcClient (RPC mode)
    ↓
pi binary (--mode rpc --no-session)
    ↓
AI Processing
    ↓
Response sent back to Telegram
```

## Files

- `telegram-bridge.ts`: Main bridge service that connects Telegram to pi
- `telegram-notify.ts`: pi extension that provides `/tg` command and `telegram_send` tool
- `start-bridge.sh`: Wrapper script for launching bridge with proper environment
- `telegram-config.example.json`: Example configuration file

## Troubleshooting

### Bridge not receiving messages

1. Check if the bot token is correct
2. Make sure you've sent at least one message to the bot
3. Check the logs: `tail -f ~/.pi/telegram-bridge.log`

### 409 Conflict errors

This means another instance is polling the same bot token. Solutions:
1. Stop any other instances of the bridge
2. Create a new bot with @BotFather
3. Wait a few minutes for the old polling session to expire

### Pi process not running

Make sure pi is built and the binary exists at:
```
dist/pi-{os}-{arch}/bin/pi
```

## License

MIT
