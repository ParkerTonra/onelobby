# Make a multiplayer web game without writing code

This guide is for people who can copy and paste into an HTML file but don't program. By the end you will have a web
page where you press **Host a game**, send a link to friends, and play together.

## What OneLobby does

OneLobby connects the people who open your page so their browsers can talk to each other directly, fast enough for a
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

1. **A lobby server address.** It looks like `https://your-name.onrender.com`. You can get one of two ways:
   - Ask someone who already runs one (a friend, a club, a teacher) for its address.
   - Make your own for free in a few clicks: [deploy/EASY_SERVER.md](../deploy/EASY_SERVER.md) walks you through it
     (a free hosting account, one button, then copy the address). You only do this once, and every game you make can
     share it.
2. **A place to put your page** so friends can open it. The easiest is Netlify Drop: free, no account needed to start,
   steps in [Putting your page online](#putting-your-page-online) below. For trying it alone on your own computer you
   can just double-click the file; friends on other computers need a web address.
3. A text editor (Notepad is fine).

## Copy-paste steps

The fastest start is the finished example in [examples/drop-in/index.html](../examples/drop-in/index.html): a game
where everyone shares one click counter and can wave at each other. Copy that file, then:

1. Open it in your text editor.
2. Find the line `server="https://YOUR-LOBBY-SERVER.onrender.com"` and put your lobby server address between the
   quotes, for example `server="https://maya-lobby.onrender.com"`.
3. Change `game="click-together"` to a short name for your game, without spaces. Only players with the same game
   name can meet, so pick something unique, like `maya-space-race`.
4. Save. Double-click the file to try it alone, then [put it online](#putting-your-page-online) to play with friends.

If you'd rather add a lobby to a page you already have, paste these three pieces in.

**1. In the `<head>` part of the page** (this loads OneLobby):

```html
<script src="https://unpkg.com/onelobby@0.6.0/dist/onelobby.global.min.js"></script>
```

**2. Where you want the lobby box to appear.** The sentence inside only shows if the line above didn't work, so you
notice straight away:

```html
<one-lobby server="https://YOUR-LOBBY-SERVER.onrender.com" game="my-game" max-players="4">
  If you can read this, the OneLobby script didn't load. Check the script line in the head and your internet connection.
</one-lobby>
```

**3. Your game's code. Paste it just before `</body>`** (the end of the page). Put all your game lines inside this one
block, where it says so:

```html
<script type="module">
  // Wait until the lobby box is ready (this also makes it work if the block ends up somewhere else on the page).
  await customElements.whenDefined("one-lobby");
  const lobby = document.querySelector("one-lobby");

  // Your game lines go here. For example: show a message when the host presses Start.
  lobby.addEventListener("start", () => { alert("The game has started!"); });
</script>
```

### Settings on the lobby box

| Setting | What it does | Example |
|---|---|---|
| `server` | Your lobby server address. Required. | `server="https://maya-lobby.onrender.com"` |
| `game` | A short name for your game. Players only meet others with the same name. | `game="maya-space-race"` |
| `max-players` | How many people fit in one game (2 or more). | `max-players="6"` |
| `name` | Optional. Sets the player's name and hides the name box. | `name="Guest"` |
| `theme` | `light`, `dark`, or `auto` (follows the visitor's device). | `theme="dark"` |
| `version` | Optional. Change it (for example to `2`) when you change your game, so old and new copies don't mix. | `version="2"` |

### Making the game react

Your game talks to the lobby box with a few short lines. Put them in the block from piece 3 above, where it says
"Your game lines go here", and change the words.

| You want to... | Write this |
|---|---|
| Do something when the host presses Start | `lobby.addEventListener("start", () => { ... })` |
| Add 1 to a number everyone shares | `lobby.shared.add("score")` |
| Set a shared value | `lobby.shared.set("color", "red")` |
| Read a shared value | `lobby.shared.get("score")` |
| Reset a shared value (for a new round) | `lobby.shared.set("score", null)` (it reads as empty again) |
| Do something when a shared value changes | `lobby.addEventListener("shared-change", () => { ... })` |
| Send a message to everyone else | `lobby.send("hello")` |
| Do something when a message arrives | `lobby.addEventListener("message", (event) => { ... event.detail.data ... event.detail.from.name ... })` |
| Know when someone joins or leaves | `player-joined` and `player-left` events, with `event.detail.player.name` |
| Check if you are the host | `lobby.isHost` |
| List the players | `lobby.players` (each has a `name`) |
| Know which player you are | `lobby.players.find((p) => p.isMe).name` |

**Shared values** are the easy way to keep everyone in step: the host's page keeps the official copy, everyone's page
asks it to make changes, and every page gets the same result in the same order. Use `add` for scores and counters, so
two people clicking at the same moment both count. Setting a value to `null` removes it. Shared values can be numbers,
text, true/false, lists, or groups of those.

### Changing the look

The lobby box follows your colours if you set these on it in your page's style section:

```html
<style>
  one-lobby {
    --onelobby-accent: #8a2be2;   /* button colour */
    --onelobby-accent-fg: #ffffff; /* text on buttons */
    --onelobby-bg: #fffaf0;       /* box background */
    --onelobby-fg: #222222;       /* text */
    --onelobby-radius: 4px;       /* corner roundness */
    --onelobby-font: Georgia, serif;
  }
</style>
```

Others: `--onelobby-muted` (quiet text), `--onelobby-border`, `--onelobby-field` (input background), `--onelobby-danger` (error text).

## Putting your page online

Netlify Drop puts a page on the internet by dragging a folder onto a web page:

1. Make a new folder on your computer (for example `my-game`) and put your page in it.
2. Name the page file `index.html` (exactly that), so it opens first.
3. Open [app.netlify.com/drop](https://app.netlify.com/drop) and drag the whole folder onto the box on that page.
4. Wait a few seconds, then copy the address it shows (it ends in `.netlify.app`). That is the link you send friends.

A site made without an account is removed after a while: sign up for free on that page (it offers to "claim" the site)
to keep it. To change your game later, drag the folder again from your site's **Deploys** page. Any other free static
web host works too: GitHub Pages, Cloudflare Pages, or your school or club website.

## Playing with friends

1. Open your page and type your name.
2. Press **Host a game**. A big code appears.
3. Press **Copy invite link** and paste it into a message to your friends. When they open it, the code is already
   filled in; they type their name and press **Join**. (Or read the code out loud and they type it in.)
4. You see everyone in the **Players** list. Press **Start** when everyone's in.
5. Friends who open the link after the start still join, and see the game as it is now.

If the host closes their page, another player automatically takes over as host and the game carries on. If someone
reloads the page by accident, they get their seat back on their own (same tab, as long as the game is still going).

## When something goes wrong

The lobby box explains problems in plain words and offers **Try again**. The common ones:

| You see | What it means | What to do |
|---|---|---|
| The sentence "If you can read this, the OneLobby script didn't load" | The script line in the `<head>` is missing, mistyped, or you are offline. | Copy piece 1 again exactly, check your internet, reload. |
| This page is missing its lobby server address | The `server="..."` setting is empty, still says `YOUR-LOBBY-SERVER`, or isn't an address. | Put your lobby server address in it (see "What you need"). |
| Couldn't reach the game server | The address is wrong, the lobby server is off or asleep, or you're offline. | Check the address (it looks like `https://your-name.onrender.com`). A free server that was asleep wakes up in about a minute: try again. Check your internet, or ask whoever runs the server. |
| My buttons do nothing | Your game lines are outside the piece 3 block, or above it on the page. | Put every game line inside the `<script type="module">` block from piece 3, and paste that block just before `</body>`. |
| We couldn't find a lobby with that code | A typo, or everyone already left. | Check the code. Letters and numbers only; `O` and `0` count as the same, so do `I`, `L` and `1`. |
| That lobby is full | Already `max-players` people in it. | The host can raise `max-players` and host again. |
| You and the host are running different versions of the game | One of you has an older copy of the page. | Both reload the page. |
| Couldn't connect to the other players | Your two networks won't let the browsers reach each other directly (common on school, work or public Wi-Fi). It gives up after about 15 seconds. | Try again, or switch one person to a phone hotspot. If it keeps happening, whoever runs the lobby server can add a relay (advanced, for them: [RUN_YOUR_OWN.md](../deploy/RUN_YOUR_OWN.md)). |
| This game server doesn't host this game | The lobby server only allows certain game names. | Ask the server owner to allow your `game` name. |
| The game server is full right now | Too many games at once on that server. | Try again in a few minutes. |

It also helps to:

- Use a recent Chrome, Edge, Firefox or Safari.
- Open the page from a web address (`https://...`). Some features, like the copy buttons, need it.
- Try with two windows on your own computer first: host in one, join in the other (use a private window for the
  second so it gets its own name).

## Words you might see elsewhere

- **Lobby server**: the helper website that hands out codes and introduces players. It doesn't carry the game.
- **Host**: the player who pressed Host a game. Their page keeps the official copy of shared values.
- **WebRTC**: the browser feature that lets two browsers talk to each other directly. OneLobby uses it for you.
- **Signaling**: the "here is how to reach me" notes the lobby server passes between players before they connect.
- **TURN / relay**: a go-between that carries game traffic when two networks refuse a direct connection.
