#ifndef PROCTOR_SMBIOS_H
#define PROCTOR_SMBIOS_H
#include <stddef.h>

/* Bounds-check both the formatted record and its terminated string set before
   exposing SMBIOS type 1 identity. No dependency on WMI or the C runtime. */
static const char *smbios_string(const unsigned char *begin, const unsigned char *end, unsigned int index) {
    if (!index) return NULL;
    const unsigned char *p = begin;
    for (unsigned int current = 1; p < end && *p; current++) {
        if (current == index) return (const char *)p;
        while (p < end && *p) p++;
        if (p < end) p++;
    }
    return NULL;
}

static int smbios_identity(const unsigned char *raw, size_t size, const char **manufacturer, const char **model) {
    *manufacturer = NULL;
    *model = NULL;
    if (size < 8) return 0;
    size_t length = (size_t)raw[4] | (size_t)raw[5] << 8 | (size_t)raw[6] << 16 | (size_t)raw[7] << 24;
    if (length > size - 8) return 0;
    const unsigned char *p = raw + 8, *end = p + length;
    while ((size_t)(end - p) >= 4) {
        if (p[1] < 4 || p[1] > (size_t)(end - p)) return 0;
        const unsigned char *strings = p + p[1], *terminator = strings;
        while ((size_t)(end - terminator) >= 2 && (terminator[0] || terminator[1])) terminator++;
        if ((size_t)(end - terminator) < 2) return 0;
        if (p[0] == 1 && p[1] >= 6) {
            *manufacturer = smbios_string(strings, terminator + 1, p[4]);
            *model = smbios_string(strings, terminator + 1, p[5]);
            return *manufacturer != NULL || *model != NULL;
        }
        if (p[0] == 127) break;
        p = terminator + 2;
    }
    return 0;
}
#endif
