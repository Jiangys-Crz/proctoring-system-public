#ifndef PROCTOR_SCREEN_KEYBOARD_POLICY_H
#define PROCTOR_SCREEN_KEYBOARD_POLICY_H

/* Portable policy, shared with the native test harness. No key logging. */
static int screen_control_block_key(unsigned long key, int control, int alt, int win) {
    /* Windows owns the secure attention sequence; never interfere with it. */
    if (key == 0x2e && control && alt) return 0; /* Ctrl+Alt+Delete */
    if (key == 0x5b || key == 0x5c || win) return 1;
    if (alt && (key == 0x09 || key == 0x1b || key == 0x73)) return 1;
    if (control && key == 0x1b) return 1; /* Includes Ctrl+Shift+Esc. */
    return 0;
}
#endif
