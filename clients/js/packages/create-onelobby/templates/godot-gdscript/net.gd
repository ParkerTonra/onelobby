extends Node
## The autoload "Net": the game's one OneLobbyClient, built from res://onelobby.json and pumped every frame.
## The drop-in menu drives this client (main.gd hands it over); once a game has started the lobby is Net.client.lobby.
## No class_name on purpose: a global class name could clash with one of the game's own; use the autoload Net.
## Recipe: {{recipeUrl}}

var client: OneLobbyClient


func _ready() -> void:
	client = OneLobbyClient.from_config("res://onelobby.json", {"display_name": "Player"})
	if not client.config_error.is_empty():
		push_error("onelobby.json: " + str(client.config_error["message"])) # path and rule are in the dictionary too
	add_child(client) # pumps signaling and peer links every frame; signals fire on the main thread
