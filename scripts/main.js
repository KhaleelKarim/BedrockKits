// ============================================================================
// KIT ENGINE
// ----------------------------------------------------------------------------
// Build custom items at runtime from a /scriptevent command, including items
// that trigger a "power" when you right-click another player, with a limited
// number of uses.
//
// Usage in chat (all one line):
//   /scriptevent kits:give {"id":"minecraft:netherite_sword","name":"Ashbringer"}
//
// See the bottom of this file for a full list of spec fields.
// ============================================================================

import {
  world,
  system,
  ItemStack,
  EnchantmentType,
  EquipmentSlot,
} from "@minecraft/server";

// ============================================================================
// SECTION 1: THE POWER REGISTRY
// ----------------------------------------------------------------------------
// Each entry maps a power name (the string you type in the spec) to a function
// that runs when the item is right-clicked on a player.
//
// Every function receives:
//   source = the player holding the item (the attacker)
//   target = the entity that got right-clicked (usually the victim player)
//
// To add a new power, just add a new key here. No other file changes needed.
// ============================================================================

const POWERS = {
  // Drops a lightning bolt directly on the target's position.
  // spawnEntity needs a dimension; we use the TARGET's dimension so this still
  // works if source and target are somehow in different dimensions.
  lightning: (source, target) => {
    target.dimension.spawnEntity("minecraft:lightning_bolt", target.location);
  },

  // Poison II for 10 seconds. Durations are in TICKS: 20 ticks = 1 second.
  // amplifier 0 = level I, amplifier 1 = level II, and so on.
  poison: (source, target) => {
    target.addEffect("poison", 200, { amplifier: 1 });
  },

  // Sets the target on fire for 8 seconds.
  // The second argument (true) means "use the effect even if they're already
  // burning" — it refreshes the timer rather than being ignored.
  ignite: (source, target) => {
    target.setOnFire(8, true);
  },

  // Instant Health II — a "friendly" power, useful for support kits.
  // Duration of 1 tick because instant effects apply immediately and end.
  heal: (source, target) => {
    target.addEffect("instant_health", 1, { amplifier: 1 });
  },

  // Launches the target into the air.
  // NOTE: applyKnockback's signature has changed between Script API versions.
  // If this throws, check the Entity class docs for the current parameter shape
  // and adjust — the concept works, only the argument format drifts.
  launch: (source, target) => {
    target.applyKnockback({ x: 0, z: 0 }, 2.5);
  },

  // Slowness IV + Weakness II for 15 seconds — a "curse" style power.
  // Shows that one power can stack multiple effects.
  curse: (source, target) => {
    target.addEffect("slowness", 300, { amplifier: 3 });
    target.addEffect("weakness", 300, { amplifier: 1 });
  },
};

// ============================================================================
// SECTION 2: BUILDING AN ITEM FROM A SPEC
// ----------------------------------------------------------------------------
// Takes a plain JavaScript object (parsed from the JSON you typed in chat) and
// returns { item, warnings } where:
//   item     = the finished ItemStack, ready to hand to a player
//   warnings = list of things that couldn't be applied, so you get told rather
//              than silently receiving a half-built item
// ============================================================================

function buildItem(spec) {
  const warnings = [];

  // --- Base item ---------------------------------------------------------
  // ItemStack's constructor throws on an unknown item id, so we let that
  // bubble up to the caller, which reports it to the player.
  const item = new ItemStack(spec.id, spec.count ?? 1);

  // --- Custom name -------------------------------------------------------
  // nameTag is the display name. You can embed color codes with the section
  // sign, e.g. "\u00a76Ashbringer" for gold text.
  if (spec.name) {
    item.nameTag = spec.name;
  }

  // --- Lore (the grey text under the name) -------------------------------
  // Expects an array of strings, one per line.
  if (spec.lore) {
    item.setLore(spec.lore);
  }

  // --- Enchantments ------------------------------------------------------
  // getComponent returns undefined if this item type can't be enchanted at all
  // (e.g. a stone block), so we check before using it.
  if (spec.enchants) {
    const enchantable = item.getComponent("minecraft:enchantable");

    if (!enchantable) {
      warnings.push(`${spec.id} cannot hold enchantments at all`);
    } else {
      for (const [enchantId, level] of Object.entries(spec.enchants)) {
        try {
          enchantable.addEnchantment({
            type: new EnchantmentType(enchantId),
            level: level,
          });
        } catch (e) {
          // This is the expected failure path for illegal enchantments:
          // wrong item type, or level above the vanilla cap. We record it
          // instead of crashing, so the rest of the item still gets built.
          warnings.push(
            `enchant "${enchantId} ${level}" rejected (incompatible or over cap) - use the loot table route for this one`
          );
        }
      }
    }
  }

  // --- Durability (how worn the item looks) ------------------------------
  // "damage" counts UP from 0. damage 0 = pristine, damage near maxDurability
  // = about to break. So "low durability" means a HIGH damage number.
  if (spec.damage != null) {
    const durability = item.getComponent("minecraft:durability");

    if (!durability) {
      warnings.push(`${spec.id} has no durability bar`);
    } else {
      // Clamp to maxDurability - 1 so we never accidentally set it to exactly
      // broken, which can make the item vanish the moment it's used.
      const maxSafe = durability.maxDurability - 1;
      durability.damage = Math.min(spec.damage, maxSafe);
    }
  }

  // --- Power metadata ----------------------------------------------------
  // Dynamic properties are custom key/value data that rides along with this
  // specific ItemStack and survives being dropped, stored in a chest, etc.
  // This is how the right-click handler later knows the item is special.
  if (spec.power) {

    // Dynamic properties are how we tag an item as "special", but the API only
    // allows them on NON-STACKABLE items. Stackable items merge in the
    // inventory, which would destroy per-item data like remaining uses, so
    // the API refuses outright. maxAmount is the item TYPE's stack limit
    // (64 for a stick, 1 for a sword) - note this is unrelated to spec.count.
    if (item.maxAmount > 1) {
      throw new Error(
        `"${spec.id}" is stackable (stacks to ${item.maxAmount}), so it can't ` +
        `carry a power. Use a non-stackable base instead - anything with a ` +
        `durability bar works: carrot_on_a_stick, fishing_rod, wooden_hoe, ` +
        `trident, or any sword/armor piece.`
      );
    }

    if (!POWERS[spec.power]) {
      warnings.push(
        `unknown power "${spec.power}" - known powers: ${Object.keys(POWERS).join(", ")}`
      );
    }

    item.setDynamicProperty("kit:power", spec.power);

    // uses: how many right-clicks before the item is spent.
    // -1 means unlimited (the default if you don't specify).
    item.setDynamicProperty("kit:uses", spec.uses ?? -1);

    // onEmpty: what happens when uses hit zero.
    //   "vanish" = item disappears
    //   "keep"   = item stays but stops working
    item.setDynamicProperty("kit:onEmpty", spec.onEmpty ?? "vanish");
  }

  return { item, warnings };
}

// ============================================================================
// SECTION 3: THE /scriptevent COMMAND HANDLER
// ----------------------------------------------------------------------------
// Listens for:  /scriptevent kits:give {...json...}
// and puts the resulting item in the running player's inventory.
// ============================================================================

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "kits:give") return;
  console.log(`Event recieved, source entity is ${event.sourceEntity.name}`)
  // sourceEntity is whoever ran the command. It's undefined if the command
  // came from a command block or the server console, in which case we have
  // nobody to give the item to.
  const player = event.sourceEntity;
  if (!player) return;

  // Wrap the actual work in system.run(). Event handlers can fire during
  // restricted-execution windows where world-modifying calls are blocked;
  // system.run defers to the next tick where everything is legal.
  system.run(() => {
    // --- Parse the JSON the player typed --------------------------------
    let spec;
    try {
      spec = JSON.parse(event.message);
    } catch (e) {
      player.sendMessage(`§cBad JSON: ${e}`);
      return;
    }

    // --- Build the item --------------------------------------------------
    let result;
    try {
      result = buildItem(spec);
    } catch (e) {
      // Almost always an invalid item id.
      player.sendMessage(`§cCouldn't build item: ${e}`);
      return;
    }

    // --- Hand it over ----------------------------------------------------
    const inventory = player.getComponent("minecraft:inventory");
    if (!inventory) {
      player.sendMessage("§cNo inventory component found");
      return;
    }
    inventory.container.addItem(result.item);

    // --- Report ----------------------------------------------------------
    player.sendMessage(`§aGave: ${spec.name ?? spec.id}`);
    for (const warning of result.warnings) {
      player.sendMessage(`§e! ${warning}`);
    }
  });
});

// ============================================================================
// SECTION 4: THE RIGHT-CLICK POWER HANDLER
// ----------------------------------------------------------------------------
// Fires whenever a player right-clicks any entity while holding an item.
// We check whether that item carries a "kit:power" tag, and if so, run it.
// ============================================================================
world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
  const player = event.player;
  const target = event.target;
  const usedItem = event.itemStack;
  world.sendMessage(`Player: ${player}, Target: ${target}, Used Item: ${usedItem}`);

  // Bare-handed right-click, or right-clicking with a normal item.
  if (!usedItem) return;

  // Read the power tag we stamped on in buildItem().
  // Plain items have no such property, so they exit here immediately.
  const powerName = usedItem.getDynamicProperty("kit:power");
  if (!powerName) return;

  const powerFn = POWERS[powerName];
  if (!powerFn) {
    player.sendMessage(`§cThis item has an unknown power: ${powerName}`);
    return;
  }

  // Check remaining uses BEFORE firing, so a spent item does nothing.
  const remaining = usedItem.getDynamicProperty("kit:uses");
  const isLimited = typeof remaining === "number" && remaining >= 0;

  if (isLimited && remaining <= 0) {
    player.sendMessage("§7This item is spent.");
    return;
  }

  // Deferred again: afterEvents run inside a restricted window, and spawning
  // entities / adding effects would be blocked if called directly here.
  system.run(() => {
    try {
      powerFn(player, target);
    } catch (e) {
      player.sendMessage(`§cPower failed: ${e}`);
      return;
    }

    if (isLimited) {
      consumeUse(player, remaining);
    }
  });
});

// ============================================================================
// SECTION 5: SPENDING A USE
// ----------------------------------------------------------------------------
// Decrements the use counter on the item currently in the player's main hand,
// and removes the item if that was the last use.
//
// IMPORTANT CONCEPT: the ItemStack you get from an event is a *copy*, not a
// live reference to the item in the player's hand. Changing it does nothing
// until you write it back into the inventory slot. That's why this function
// re-fetches the held item and calls setEquipment at the end.
// ============================================================================

function consumeUse(player, previousRemaining) {
  const equippable = player.getComponent("minecraft:equippable");
  if (!equippable) return;

  // Re-fetch the real held item rather than trusting the event's copy.
  const held = equippable.getEquipment(EquipmentSlot.Mainhand);
  if (!held) return;

  const newRemaining = previousRemaining - 1;

  if (newRemaining > 0) {
    // Still has charges left: update the counter and write the item back.
    held.setDynamicProperty("kit:uses", newRemaining);
    equippable.setEquipment(EquipmentSlot.Mainhand, held);
    player.onScreenDisplay.setActionBar(`${newRemaining} uses left`);
  } else {
    // Last charge just got spent.
    const mode = held.getDynamicProperty("kit:onEmpty");

    if (mode === "keep") {
      // Leave the item but mark it as dead so the guard in Section 4 stops it.
      held.setDynamicProperty("kit:uses", 0);
      equippable.setEquipment(EquipmentSlot.Mainhand, held);
      player.onScreenDisplay.setActionBar("Item is spent");
    } else {
      // Default "vanish": passing undefined clears the slot entirely.
      equippable.setEquipment(EquipmentSlot.Mainhand, undefined);
      player.onScreenDisplay.setActionBar("Item consumed");
    }
  }
}

// ============================================================================
// SECTION 6: STARTUP MESSAGE
// ----------------------------------------------------------------------------
// Deferred with system.run because world.sendMessage is blocked during the
// early-execution window when this file first loads.
// ============================================================================

system.run(() => {
  world.sendMessage("§aKit Engine loaded.");
});

// ============================================================================
// SPEC REFERENCE
// ----------------------------------------------------------------------------
// {
//   "id":      "minecraft:netherite_sword",   REQUIRED, any vanilla item id
//   "count":   1,                             optional, default 1
//   "name":    "Ashbringer",                  optional, supports \u00a7 color codes
//   "lore":    ["line one", "line two"],      optional
//   "enchants": { "sharpness": 5,             optional, legal combos only
//                 "unbreaking": 3 },
//   "damage":  800,                           optional, HIGHER = more worn
//   "power":   "lightning",                   optional, see POWERS above
//   "uses":    3,                             optional, -1 = unlimited
//   "onEmpty": "vanish"                       optional, "vanish" or "keep"
// }
//
// EXAMPLES
//
// Worn, named, enchanted sword:
//   /scriptevent kits:give {"id":"minecraft:netherite_sword","name":"Ashbringer","enchants":{"sharpness":5,"unbreaking":3},"damage":1800}
//
// Three-use lightning shears:
//   /scriptevent kits:give {"id":"minecraft:shears","name":"Thunder Rod","power":"lightning","uses":3}
//
// Unlimited healing feather that stays forever:
//   /scriptevent kits:give {"id":"minecraft:feather","name":"Mercy","power":"heal","uses":-1}
// ============================================================================