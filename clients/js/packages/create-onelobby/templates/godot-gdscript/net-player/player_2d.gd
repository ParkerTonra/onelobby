extends CharacterBody2D
## One player's character: the scene player.tscn, one copy per player on every machine. The OneLobbyNetPlayer child ($NetPlayer)
## does the networking; this script only reads the keyboard of the local player. A side-on platformer: left and right, jump. Yours to edit.
#@if owner
## Authority "owner" (sync.player.authority in onelobby.json): the player's own PC moves this body as in any single-player game and the
## node sends where it is. On every other PC the node moves the body, so this script does nothing there.
## (For "host" authority, set sync.player.authority to "host" and scaffold again, or see docs/recipes/net-player.md section 10:
## the node is given set_input() and one pure step function instead.)
#@end
#@if host
## Authority "host" (sync.player.authority in onelobby.json): this script does NOT move the body. It tells the node what the keys say
## (set_input) and the node moves the body with step(), the same function the host runs; the host has the last word.
## (For "owner" authority, where the player's own PC moves the body, set sync.player.authority to "owner" and scaffold again, or see
## docs/recipes/net-player.md section 10.)
#@end

const SPEED := 220.0
const JUMP_SPEED := 420.0
const GRAVITY := 1100.0
const COLORS := [Color(0.9, 0.3, 0.3), Color(0.3, 0.5, 0.95), Color(0.3, 0.8, 0.4), Color(0.95, 0.8, 0.25), Color(0.7, 0.4, 0.9), Color(0.3, 0.85, 0.85), Color(0.95, 0.55, 0.2), Color(0.8, 0.8, 0.8)]
#@if host
const GROUND_Y := -16.0 # the square's centre when it stands on the floor (the floor's top is at y = 0, the square is 32 high)
#@end

@onready var net: OneLobbyNetPlayer = $NetPlayer
@onready var body: Polygon2D = $Body
@onready var label: Label = $Name

var _color_team := -1
#@if host
var _jump_down := false
#@end


## game.gd calls this when the character appears: the name over its head and (the local one) a team, which is the colour on every screen.
func setup(display_name: String, team: int) -> void:
	label.text = display_name
	if net.is_local:
		net.team = team


#@if owner
func _physics_process(delta: float) -> void:
	if not net.is_local:
		return # on the other machines the node moves this body
	velocity.x = _read_move() * SPEED
	if is_on_floor():
		velocity.y = 0.0
		if _jump_pressed():
			velocity.y = -JUMP_SPEED
			net.jump() # the others see (and hear) it at the right moment
	else:
		velocity.y += GRAVITY * delta
	move_and_slide()
#@end
#@if host
func _physics_process(_delta: float) -> void:
	if not net.is_local:
		return
	var jump := _jump_pressed()
	var local: Dictionary = net.players().local_state() if net.players() != null else {}
	if jump and not _jump_down and bool(local.get("on_ground", true)):
		net.jump() # the others see (and hear) it at the right moment
	_jump_down = jump
	net.set_input({"move_x": _read_move(), "move_y": 0.0, "yaw": 0.0, "buttons": {"jump": jump}})


## One step of movement, the same on the host and on every owner (it must depend only on its three arguments): the node calls it
## through the spawner's step_function (game.gd sets it). The y axis points down, so a jump is a negative vy.
static func step(state: Dictionary, input: Dictionary, dt: float) -> Dictionary:
	var out := state.duplicate()
	var y := float(state["y"])
	var vy := float(state.get("vy", 0.0))
	var buttons: Dictionary = input.get("buttons", {})
	if y >= GROUND_Y - 0.001 and bool(buttons.get("jump", false)):
		vy = -JUMP_SPEED
	if y < GROUND_Y - 0.001 or vy < 0.0:
		vy += GRAVITY * dt
	y += vy * dt
	var grounded := y >= GROUND_Y
	if grounded:
		y = GROUND_Y
		vy = 0.0
	var mx := float(input.get("move_x", 0.0))
	out["x"] = float(state["x"]) + mx * SPEED * dt
	out["y"] = y
	out["vx"] = mx * SPEED
	out["vy"] = vy
	out["on_ground"] = grounded
	return out
#@end


func _read_move() -> float:
	var move := Input.get_axis("ui_left", "ui_right") # the arrow keys
	if Input.is_key_pressed(KEY_A):
		move -= 1.0
	if Input.is_key_pressed(KEY_D):
		move += 1.0
	return clampf(move, -1.0, 1.0)


func _jump_pressed() -> bool:
	return Input.is_key_pressed(KEY_SPACE) or Input.is_key_pressed(KEY_UP) or Input.is_key_pressed(KEY_W)


func _process(_delta: float) -> void:
	if _color_team != net.team:
		_color_team = net.team
		body.color = COLORS[net.team % COLORS.size()]
