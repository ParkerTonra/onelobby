extends CharacterBody3D
## One capsule. The local one walks with the arrow keys or WASD and jumps with space; every other one is moved by its
## OneLobbyNetPlayer node (position and facing arrive from the network), so this script only moves the local player.

const SPEED := 5.0
const JUMP_SPEED := 6.0
const GRAVITY := 18.0
const COLORS := [Color(0.9, 0.3, 0.3), Color(0.3, 0.5, 0.95), Color(0.3, 0.8, 0.4), Color(0.95, 0.8, 0.25), Color(0.7, 0.4, 0.9), Color(0.3, 0.85, 0.85), Color(0.95, 0.55, 0.2), Color(0.8, 0.8, 0.8)]

## The headless test drives the local player with this instead of the keyboard: `Callable() -> {move: Vector2, jump: bool}`.
var scripted := Callable()

@onready var net: OneLobbyNetPlayer = $NetPlayer
@onready var body: MeshInstance3D = $Body
@onready var label: Label3D = $Name

var _color_team := -1


## The player's name over its head, and (the local one) its team: the colour travels as the `team` of the state.
func setup(display_name: String, team: int) -> void:
	label.text = display_name
	if net.is_local:
		net.team = team


func _physics_process(delta: float) -> void:
	if not net.is_local:
		return
	var move := Vector2.ZERO
	var want_jump := false
	if scripted.is_valid():
		var s: Dictionary = scripted.call()
		move = s.get("move", Vector2.ZERO)
		want_jump = bool(s.get("jump", false))
	else:
		move = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
		if Input.is_key_pressed(KEY_A):
			move.x -= 1.0
		if Input.is_key_pressed(KEY_D):
			move.x += 1.0
		if Input.is_key_pressed(KEY_W):
			move.y -= 1.0
		if Input.is_key_pressed(KEY_S):
			move.y += 1.0
		move = move.limit_length(1.0)
		want_jump = Input.is_key_pressed(KEY_SPACE)
	velocity.x = move.x * SPEED
	velocity.z = move.y * SPEED
	if is_on_floor():
		velocity.y = 0.0
		if want_jump:
			velocity.y = JUMP_SPEED
			net.jump() # the others see (and hear) it at the right moment
	else:
		velocity.y -= GRAVITY * delta
	if move.length() > 0.01:
		rotation.y = atan2(-move.x, -move.y)
	move_and_slide()


func _process(_delta: float) -> void:
	if _color_team != net.team:
		_color_team = net.team
		var m := StandardMaterial3D.new()
		m.albedo_color = COLORS[net.team % COLORS.size()]
		body.material_override = m
