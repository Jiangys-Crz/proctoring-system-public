#ifndef PROCTOR_BUFFERED_OUTPUT_H
#define PROCTOR_BUFFERED_OUTPUT_H

/* The collector quotes UTF-8 byte by byte. Buffer those bytes so an older
   Windows machine does not need one kernel/pipe write per character. The
   caller supplies output_sink(), which either writes all bytes or fails. */
static char output_buffer[16384];
static unsigned long output_used;
static void flush_output(void) {
    if (!output_used) return;
    output_sink(output_buffer, output_used);
    output_used = 0;
}
static void write_bytes(const char *bytes, unsigned long length) {
    while (length) {
        unsigned long room = sizeof(output_buffer) - output_used;
        unsigned long count = length < room ? length : room;
        for (unsigned long i = 0; i < count; i++) output_buffer[output_used + i] = bytes[i];
        output_used += count;
        bytes += count;
        length -= count;
        if (output_used == sizeof(output_buffer)) flush_output();
    }
}

#endif
