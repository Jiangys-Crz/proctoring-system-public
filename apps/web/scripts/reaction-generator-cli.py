"""Run the official ICPC CLI with narrowly scoped deployment adaptations.

The upstream template/rendering code stays in its separately installed package.
No network fetches or credentials are needed to render a saved reaction.
"""
import json
import functools
import math
import os
from pathlib import Path
import sys

from PIL import Image, ImageFont
from reactions_generator import card, cli, fonts
from reactions_generator.colors import Colors


@functools.lru_cache(maxsize=256)
def weighted_font(filename, size, weight):
    """Keep variable-font weight when the upstream layout resizes a font."""
    font = ImageFont.truetype(filename, size=size)
    try:
        axes = font.get_variation_axes()
        values = [max(axis["minimum"], min(axis["maximum"], weight))
                  if axis["name"] in (b"Weight", "Weight") else axis["default"] for axis in axes]
        font.set_variation_by_axes(values)
    except OSError:
        pass  # Static regular/bold files already carry their intended weight.

    def variant(font=None, size=None, index=None, encoding=None, layout_engine=None):
        return weighted_font(font or filename, size or original_size, weight)

    original_size = size
    font.font_variant = variant
    return font


def configure_typography(spec):
    presentation = spec.get("presentation") or {}
    classic = presentation.get("fontPreset") == "classic"
    windows = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    noto = [str(windows / "NotoSansSC-VF.ttf"),
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc"]
    noto_bold = [str(windows / "NotoSansSC-VF.ttf"),
                 "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
                 "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc"]
    yahei, yahei_bold = str(windows / "msyh.ttc"), str(windows / "msyhbd.ttc")

    def select(explicit, candidates):
        if explicit and not Path(explicit).is_file():
            raise ValueError("REACTION_GENERATOR_FONT_UNAVAILABLE")
        return next((value for value in ([explicit] if explicit else candidates) if value and Path(value).is_file()), None)

    regular_path = select(os.environ.get("REACTION_GENERATOR_FONT"),
                          [yahei, *noto] if classic else [*noto, yahei])
    bold_path = select(os.environ.get("REACTION_GENERATOR_FONT_BOLD"),
                       [yahei_bold, *noto_bold] if classic else [*noto_bold, yahei_bold])
    mono_path = select(None, [str(windows / "consola.ttf"),
                              "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"])
    supplied_text = spec["teamName"] + (spec.get("schoolName") or "")
    if any("\u2e80" <= character <= "\ud7ff" for character in supplied_text) and not (regular_path and bold_path):
        raise ValueError("REACTION_GENERATOR_FONT_REQUIRED_FOR_CJK")
    official_text = card.auto_resize_text

    def styled_text(text, dimensions, font, allow_multiline, allow_compression, align_center, max_size=150):
        if allow_multiline:  # Team title: real bold, bounded size, no squeezed glyphs.
            max_size = 60 if not classic else 58
            if bold_path:
                font = weighted_font(bold_path, 10, 700)
            allow_compression = False
            if font.font_variant(size=max_size).getlength(text) <= dimensions[0]:
                allow_multiline = False
        elif not align_center:  # School: quieter regular hierarchy.
            max_size = 30
            if regular_path:
                font = weighted_font(regular_path, 10, 400)
        elif max_size == 150:  # Problem letter retains the official bold face.
            font = fonts.load_bold(10)
            max_size = 116
        else:  # Sans monospace keeps the elapsed clock crisp and aligned.
            font = weighted_font(mono_path, 10, 400) if mono_path else fonts.load_monspaced(10)
            max_size = 32
        return official_text(text, dimensions, font, allow_multiline, allow_compression, align_center, max_size)

    card.auto_resize_text = styled_text
    official_split = card.split_horizontal
    has_logo = presentation.get("hasLogo", False)

    def fitted_split(box, width, padding=0, gap=0):
        if width == 152 and padding == 40 and gap == 32 and not has_logo:
            width, gap = 0, 0  # Missing school logo must not leave an empty column.
        elif padding == 0 and gap == 16:
            width = max(1, box[2] - box[0] - gap - 220)
        return official_split(box, width, padding, gap)

    card.split_horizontal = fitted_split


def main():
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    assets = Path(spec["assetsDirectory"])
    assets.mkdir(parents=True, exist_ok=True)
    presentation = spec.get("presentation") or {}
    background = Path(presentation["backgroundPath"])
    logo = Path(presentation["logoPath"])
    configure_typography(spec)

    # Upstream requires integer ranks. Hide the badge altogether if either
    # value is unavailable; never let its example 100 -> 1 ranks leak through.
    known_ranks = spec.get("rankBefore") is not None and spec.get("rankAfter") is not None
    if not known_ranks:
        card.render_place = lambda _rank: Image.new("RGBA", (1, 1), (0, 0, 0, 0))

    # The original CLI assumes a fixed 30-second post-result tail. Our recorder
    # retains a configurable tail, so anchor the unchanged animation to the
    # actual judgement observation in the captured media timeline.
    official_card = cli.Card

    def submission_clock(self, _frame):
        seconds = max(0, int(self.time / 1000))
        return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"

    official_card.time_to_string = submission_clock
    judgement_included = spec.get("judgementIncluded", True)
    if not judgement_included:
        # The observed result is outside the retained prefix. Do not move it
        # earlier, reveal its verdict, play its sound or animate a future rank.
        official_card.color_animation = lambda self, _frame: Colors.yellow
        official_card.outcome_animation = lambda self, _frame: "..."

    def timed_card(**kwargs):
        animation_time = spec["judgementOffsetSeconds"] if judgement_included else spec["durationSeconds"] + 60
        kwargs["animation_start"] = round(animation_time * kwargs["fps"])
        if not judgement_included:
            kwargs["rank_after"] = kwargs["rank_before"]
        return official_card(**kwargs)

    cli.Card = timed_card

    # Bound both the encoder and filter worker pools, including on high-core
    # judge hosts. Keep the official graph, layout and animations unchanged.
    official_output = cli.ffmpeg.output
    official_input = cli.ffmpeg.input

    def bounded_input(*args, **kwargs):
        kwargs["extra_options"] = {**kwargs.get("extra_options", {}), "threads": 2}
        return official_input(*args, **kwargs)

    def bounded_output(*args, **kwargs):
        if not judgement_included:
            args = tuple(stream for stream in args if not isinstance(stream, cli.ffmpeg.AudioStream))
        kwargs["extra_options"] = {**kwargs.get("extra_options", {}), "threads": 2, "filter_complex_threads": 2, "filter_threads": 2}
        kwargs["t"] = spec["durationSeconds"]
        return official_output(*args, **kwargs)

    cli.ffmpeg.output = bounded_output
    cli.ffmpeg.input = bounded_input
    official_render = cli.render

    def bounded_render(*args, **kwargs):
        # A shorter screen/window must also bound the card producer. Otherwise
        # FFmpeg exits at -t while the official loop still writes camera frames.
        kwargs["last_frame"] = min(kwargs["last_frame"], max(0, math.ceil(spec["durationSeconds"] * kwargs["fps"] - 1e-7) - 1))
        return official_render(*args, **kwargs)

    cli.render = bounded_render
    official_adelay = cli.ffmpeg.AudioStream.adelay

    def timed_adelay(stream, *args, **kwargs):
        kwargs["delays"] = spec["judgementOffsetSeconds"] * 1000
        return official_adelay(stream, *args, **kwargs)

    cli.ffmpeg.AudioStream.adelay = timed_adelay
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    sys.argv = [
        "reactions-generator", "reaction",
        "--title", spec["teamName"],
        "--subtitle", spec.get("schoolName") or "",
        "--hashtag", "",
        "--task", spec["problemLabel"],
        "--time", str(spec["contestTimeMs"]),
        "--outcome", spec["verdict"],
        "--success" if spec["verdict"] == "AC" else "--no-success",
        "--rank-before", str(spec.get("rankBefore") or 1),
        "--rank-after", str(spec.get("rankAfter") or 1),
        "--logo-source", str(logo),
        "--background-source", str(background),
        "--webcam-source", spec["cameraPath"],
        "--screen-source", spec["desktopPath"],
        "--output-path", spec["outputPath"],
        "--no-print-progress",
    ]
    if not judgement_included:
        sys.argv.append("--no-sound")
    cli.main()


if __name__ == "__main__":
    main()
