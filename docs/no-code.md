# Make a multiplayer web game without writing code

This guide is for people who can copy and paste into an HTML file but don't program. By the end you will have a web
page where you press **Host a game**, send a link to friends, and play together.

## What Keepalive does

Keepalive connects the people who open your page so their browsers can talk to each other directly, fast enough for a
game. It gives you a ready-made **lobby box** for your page:

- a **Host a game** button that makes a short code like `K7M 2QX`
- a box to **type a code** and join, and an **invite link** you can paste into any chat
- a **player list** with everyone's name
- a **Start** button for the person who hosted
- plain messages when something goes wrong, with a **Try again** button

Players' browsers send the game moves to each other directly. A small helper website, called a **lobby server**, is
only used to introduce them (it hands out the codes and passes along "here is how to reach me" notes). It never sees the
game itself.

## What you need

1. **A lobby server address.** It looks like `wss://lobby.example.com`. You can get one of two ways:
   - Ask someone who already runs one (a friend, a club, a teacher) for its address.
   - Run your own. It is one program on a small rented computer (about the price of a coffee a month). Step by step
     instructions, including a one-click option, are in [deploy/RUN_YOUR_OWN.md](../deploy/RUN_YOUR_OWN.md). You only
     do this once, and every game you make can share it.
2. **A place to put your page** so friends can open it. Any free static web host works: GitHub Pages, Netlify Drop
   (drag a folder onto the page), Cloudflare Pages, or your school or club website. For trying it alone on your own
   computer you can just double-click the file, but friends on other computers need a web address.
3. A text editor (Notepad is fine).

## Copy-paste steps

The fastest start is the finished example in [examples/drop-in/index.html](../examples/drop-in/index.html): a game
where everyone shares one click counter and can wave at each other. Copy that file, then:

1. Open it in your text editor.
2. Find the line `server="wss://YOUR-LOBBY-SERVER.example.com"` and put your lobby server address between the quotes.
3. Change `game="click-together"` to a short name for your game, without spaces. Only players with the same game
   name can meet, so pick something unique, like `maya-space-race`.
4. Save, upload to your web host, and open the page.

If you'd rather add a lobby to a page you already have, paste these two pieces in.

In the `<head>` part of the page:

```html
<script type="module" src="https://unpkg.com/@keepalive/client/dist/ui/index.js"></script>
```

Where you want the lobby box to appear:

```html
<keepalive-lobby server="wss://YOUR-LOBBY-SERVER.example.com" game="my-game" max-players="4"></keepalive-lobby>
```

### Settings on the lobby box

| Setting | What it does | Example |
|---|---|---|
| `server` | Your lobby server address. Required. | `server="wss://lobby.example.com"` |
| `game` | A short name for your game. Players only meet others with the same name. | `game="maya-space-race"` |
| `max-players` | How many people fit in one game (2 or more). | `max-players="6"` |
| `name` | Optional. Sets the player's name and hides the name box. | `name="Guest"` |
| `theme` | `light`, `dark`, or `auto` (follows the visitor's device). | `theme="dark"` |
| `version` | Optional. Change it (for example to `2`) when you change your game, so old and new copies don't mix. | `version="2"` |

### Making the game react

Your page talks to the lobby box with a few short lines. Copy them from the example and change the words.

| You want to... | Write this |
|---|---|
| Do something when the host presses Start | `lobby.addEventListener("start", () => { ... })` |
| Add 1 to a number everyone shares | `lobby.shared.add("score")` |
| Set a shared value | `lobby.shared.set("color", "red")` |
| Read a shared value | `lobby.shared.get("score")` |
| Do something when a shared value changes | `lobby.addEventListener("shared-change", () => { ... })` |
| Send a message to everyone else | `lobby.send("hello")` |
| Do something when a message arrives | `lobby.addEventListener("message", (event) => { ... event.detail.data ... event.detail.from.name ... })` |
| Know when someone joins or leaves | `player-joined` and `player-left` events, with `event.detail.player.name` |
| Check if you are the host | `lobby.isHost` |
| List the players | `lobby.players` (each has a `name`) |

Where `lobby` is `document.querySelector("keepalive-lobby")`.

**Shared values** are the easy way to keep everyone in step: the host's page keeps the official copy, everyone's page
asks it to make changes, and every page gets the same result in the same order. Use `add` for scores and counters, so
two people clicking at the same moment both count. Setting a value to `null` removes it. Shared values can be numbers,
text, true/false, lists, or groups of those.

### Changing the look

The lobby box follows your colours if you set these on it in your page's style section:

```html
<style>
  keepalive-lobby {
    --ka-accent: #8a2be2;   /* button colour */
    --ka-accent-fg: #ffffff; /* text on buttons */
    --ka-bg: #fffaf0;       /* box background */
    --ka-fg: #222222;       /* text */
    --ka-radius: 4px;       /* corner roundness */
    --ka-font: Georgia, serif;
  }
</style>
```

Others: `--ka-muted` (quiet text), `--ka-border`, `--ka-field` (input background), `--ka-danger` (error text).

## Playing with friends

1. Open your page and type your name.
2. Press **Host a game**. A big code appears.
3. Press **Copy invite link** and paste it into a message to your friends. When they open it, the code is already
   filled in; they type their name and press **Join**. (Or read the code out loud and they type it in.)
4. You see everyone in the **Players** list. Press **Start** when everyone's in.
5. Friends who open the link after the start still join, and see the game as it is now.

If the host closes their page, another player automatically takes over as host and the game carries on.

## When something goes wrong

The lobby box explains problems in plain words and offers **Try again**. The common ones:

| You see | What it means | What to do |
|---|---|---|
| This page is missing its lobby server address | The `server="..."` setting is empty or missing. | Add your lobby server address (see "What you need"). |
| Couldn't reach the lobby server | The address is wrong, the lobby server is off, or you're offline. | Check the address (it should start with `wss://`), check your internet, ask whoever runs the server. |
| No game with that code | A typo, or the host already left. | Check the code. Letters and numbers only; `O` and `0` count as the same, so do `I`, `L` and `1`. |
| That game is full | Already `max-players` people in it. | The host can raise `max-players` and host again. |
| You and the host have different versions of the game | One of you has an older copy of the page. | Both reload the page. |
| Couldn't connect to the host | Your two networks won't let the browsers reach each other directly (common on school or office Wi-Fi). | Try again, or switch one person to a phone hotspot. The lobby server owner can turn on a relay (see RUN_YOUR_OWN.md, the TURN section) so this always works. |
| This lobby server doesn't host this game | The lobby server only allows certain game names. | Ask the server owner to allow your `game` name. |

It also helps to:

- Use a recent Chrome, Edge, Firefox or Safari.
- Open the page from a web address (`https://...`). Some features, like the copy buttons, need it.
- Try with two windows on your own computer first: host in one, join in the other (use a private window for the
  second so it gets its own name).

## Words you might see elsewhere

- **Lobby server**: the helper website that hands out codes and introduces players. It doesn't carry the game.
- **Host**: the player who pressed Host a game. Their page keeps the official copy of shared values.
- **WebRTC**: the browser feature that lets two browsers talk to each other directly. Keepalive uses it for you.
- **Signaling**: the "here is how to reach me" notes the lobby server passes between players before they connect.
- **TURN / relay**: a go-between that carries game traffic when two networks refuse a direct connection.
