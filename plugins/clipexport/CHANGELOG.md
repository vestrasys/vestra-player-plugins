# Changelog

## 0.6.4

**Who must change: nobody.** No new permission and the same player (0.7.6 or later). Kept Highlights results (they read as loudness-only scans), settings, the Collection and Results carry over.

- **Highlights**, the sound model (design clipexport-highlights, step 3):
  - The page now finds the moments the audience reacts to: **laughter, applause, cheering and a crowd**, besides loud peaks. A sound model on this computer listens to each 10 seconds of the sound; a sound counts where it rises above its usual level in the video (stand-up has some laughter all the time), so a laugh no louder than the talk is found too. The video never leaves the computer.
  - **First use**: above a file not scanned, the page says the model is one download (25 MB, checked after download) and offers **Download and Scan** (the click is the consent; nothing is fetched before it) and **Loudness Only** (the scan of 0.6.x, no download). The download shows its progress with Cancel ("The scan starts when it finishes."); a failed download says why with **Retry**, one that does not match its checksum is deleted (**Download Again**), and without a connection the page says so. Loudness Only is offered in each of these, and when the model cannot start on the computer. The **Find Highlights** command never downloads: without the model it opens the page, or scans by loudness once you chose Loudness Only.
  - Each suggestion shows its **kind** (Laughter, Applause, Cheering, Crowd, Loud, or two: "Laughter + applause") and a **three-bar strength meter**; its tooltip names each sound with its strength in words (strong, medium, weak) and how far it is above the video's average loudness. No percentages. The list's 5 · 10 · 20 take the suggestions with sounds first, then the loudest.
  - A scan with the model that finds loud moments only says so above the list: "Only loud moments here. Loud is not always good: check before adding."
  - **Settings ▸ Highlights**: "Sound model · 25 MB" with **Remove** while it is downloaded.
  - The model: CED-mini (Apache-2.0, by mispeech), as the ONNX int8 file of k2-fsa's sherpa-onnx, from Hugging Face at a pinned commit (10.4 MB), run by ONNX Runtime Web 1.31.1 (MIT, Microsoft): its WebAssembly file from jsDelivr (14.8 MB), its JavaScript shipped in the plugin (`vendor/`). Both downloads are kept only when they match the SHA-256 pinned in the plugin, and checked again before use. The model runs on a thread of its own, one core, only during a scan; FFmpeg reads the next five minutes of sound meanwhile. A two-hour video took about 3.5–4 minutes on our test laptop (Loudness Only: 20 s), with about 150–250 MB more memory while it ran.
- English, Simplified Chinese, German, Spanish, French, Japanese and Korean.

## 0.6.3

**Who must change: nobody.** No new permission and the same player (0.7.6 or later). Kept Highlights results and their pictures, settings, the Collection and Results carry over.

- **Highlights**:
  - Fixed: **Show** on "N highlights found" ran Find Highlights, so a file opened while the message showed, and not scanned yet, was scanned. Show is now the new command **Show Highlights** (in the command palette too): it opens the Highlights page and never starts a scan. The scanned file shows its result while it plays; another file shows its page as it is.
  - Row pictures are made only for the rows in view and a few around them (two above, four below), as the design says (§11), no longer for every listed row (up to 20). Scrolling asks for the rows it brings, once per row passed, not per pixel; a row scrolled away before its turn leaves the queue (which the Collection's thumbnails share) to what waits behind it, and gets its picture when it is in view again.
- **Animated GIF**: its first run (the palette) now shows progress like the rest of the export. FFmpeg reports progress only once every output has started, and the palette's one picture is written at the end, so the bar stood still for half the export; the run now writes each frame's time into a small work file as it goes (FFmpeg's `metadata` filter, unbuffered), which the plugin reads. The palette is the same as before.
- **Collection**: a part whose file the player no longer remembers said "File no longer known". It now says "File forgotten by the player", and the line under the buttons and the message on the video say to remove the part and add its range again. The player keeps a plugin's file references with its profile; a plugin loaded for development (`--plugin`) has them only for that run, while its data folder, and so its Collection, stays: that is the player's design, and those parts read this way after a restart.
- Korean: the part count reads "파트 3개" (it was "3개 부분"), and "added as part N" reads "N번째 파트로", without the "(으)로" particle placeholder.
- English, Simplified Chinese, German, Spanish, French, Japanese and Korean.

## 0.6.2

**Who must change: nobody.** No new permission and the same player (0.7.6 or later). Kept Highlights results, settings, the Collection and Results carry over.

- **Highlights**, review comfort (design clipexport-highlights, step 2):
  - **Row pictures**: each suggestion shows the first keyframe from its start, so you can tell the moments apart. FFmpeg makes them from the file (the player does not seek), one at a time on one core, in the queue the Collection's thumbnails use, only for the rows listed and only while the page shows. When there is no keyframe after the start (the last few seconds of a file) or the run fails, it is tried once more from the keyframe before the start; a row that still has none keeps its icon. A file of which no picture can be made (no video in it), or no FFmpeg, gets none, and opening another file stops the picture being made. They are kept beside the result (a folder per kept scan) and show at once when the file is opened again; a moved start gets a new picture; they go with the result (a changed file, the 50-file limit) and, after Scan Again, for the suggestions not found again.
  - **List keys**: after a click on a row, **Up** and **Down** select the row above or below and jump there (the list keeps it in view), **Enter** adds the selected one to the Collection and **Delete** dismisses it, each then selecting (and jumping to) the next, and **Esc** gives the keys back to the video. Enter is the new command **Add Highlight to Collection** (a key of the tab's content, like Delete in the Collection); **Dismiss Highlight** is in the command palette with no key by default, Delete being the list's own key (a second default Delete in the tab would collide with Remove from Collection).
  - **Restore N dismissed**, the last row of the list while any is dismissed, brings the dismissed ones back.
  - A scan that finishes while the Highlights page is not on screen says so on the video: "10 highlights found" (or "Nothing stood out in this video."), with **Show**, which opens the page.
- English, Simplified Chinese, German, Spanish, French, Japanese and Korean.

## 0.6.1

**Who must change: nobody.** No new permission and the same player (0.7.6 or later). Settings, the Collection and Results carry over.

- Fixed: Animated GIF and Animated WebP, and a Precise merge of the Collection with transitions, failed with "Export failed: Export failed" on a fresh install. The player writes the clip or the merge into the plugin's work folder first, and that folder did not exist yet (the player's log said "destination directory is unavailable"). The folder is now made before anything writes into it.

## 0.6.0

**Who must change: nobody.** No new permission and the same player (0.7.6 or later). Settings, the Collection and Results carry over; the sub-tab shown last stays the same page (the pages after Clip move one place to the right).

- **Highlights**, a new sub-tab between Clip and Results (design clipexport-highlights, step 1: loudness only). It finds the moments of the video playing where the sound rises (a crowd, a reaction, a big scene) and suggests ranges around them, for stand-up, talk shows, streams and sports. It measures loudness only, and its intro says no more; the sound model of a later step (laughter, applause, cheering) widens it.
  - Nothing starts by itself: **Find Highlights** (the button, or the command of that name in the command palette, category Export) scans the file. The player's FFmpeg measures the momentary loudness (EBU R 128, `ebur128`) of the sound track playing, five minutes of the video per run, in the background with progress, time left and Cancel; switching sub-tabs or hiding the sidebar keeps it running, opening another file cancels it. A two-hour 1080p film took 16 s on our test laptop (one core per run), with no dropped or late frames in the video playing (1080p30 and 2160p60).
  - A **strip** shows the whole video: its loudness as one area, a band for each suggestion (the selected one in the accent), the playhead. A click seeks; a click on a band selects that suggestion; hovering shows the time.
  - **Suggestions** in time order, the **5 · 10 · 20** strongest, each with its times, its length and kind (Loud), and in its tooltip how many LU its loudest moment is above the video's average. A range starts at the pause before the loud moment (at least 4 s, at most 60 s before: what caused the reaction) and ends at the first pause after it; without a pause there, at the quietest moment. Ranges are 6–90 s; overlapping ones merge.
  - A click on a row selects it, jumps to its start (playing stays playing) and makes it the **Range**: the Clip page's Start and End, the accent band on the seek bar. Set Clip Start / End and the row's Start and End buttons move its edges, and the row shows them. A double click plays it.
  - **+** adds it to the Collection as the last part ("Added as part N"), **×** dismisses it; it leaves the list, and the footer says how many of how many are left. **Add All** (a plain button) adds every suggestion left in time order, as many as fit (the Collection holds 100 parts).
  - While the page shows, the suggestions left are dim **region bands on the seek bar** beside the Range.
  - Each result is kept in the plugin's data folder, one small file per video and sound track (the 50 most recently used): reopening the file shows it at once, "Scanned 3 d ago · loudness only", with Scan Again. A file whose size or time changed says so and is scanned again.
  - The sound track playing is scanned (ffmpeg's stream among the file's own audio tracks); an external track cannot be, so the file's first track is, and the Scanned line says so. A file without an audio stream (ffprobe counts them first) says it has no sound.
  - The sub-tabs are as wide as their labels, so all four fit a 280 px sidebar; in a tab narrower than 317 px Highlights shows no count, and where a language's labels still do not fit, Highlights is the one shortened.
  - The page also says when there is no local file, when the file has no sound, when nothing stood out, and when FFmpeg is missing.
- English, Simplified Chinese, German, Spanish, French, Japanese and Korean.

## 0.5.1

**Who must change: nobody.** No new permission and the same player (0.7.6 or later). Settings carry over.

- While Animated GIF or Animated WebP is chosen, a small dimmed line under Advanced ▸ Quality says what it writes: `GIF · 480 px long edge · 15 fps · up to 60 s`, `WebP · 640 px long edge · 20 fps · up to 60 s`. It takes the place of the hidden H.264 rows; the ⓘ beside Fast | Precise still says it too. The numbers are the encoder's own.
- English, Simplified Chinese, German, Spanish, French, Japanese and Korean.

## 0.5.0

**Who must change: nobody.** No new permission and the same player (0.7.6 or later). Settings carry over; the Quality choice keeps what it was.

- **Animated GIF and Animated WebP**, two more choices in Advanced ▸ Quality (Precise only; Fast still copies the streams). The clip, or the merged Collection, becomes a looping image without sound, saved as `.gif` or `.webp` (a name typed in Export As… gets that extension).
  - GIF: at most 480 px on the longer side and 15 fps; one 256-colour palette made from the clip itself (`palettegen`), applied with ordered (Bayer) dithering and only the changed area of each frame (`paletteuse`), FFmpeg's documented recipe for good GIFs. Error-diffusion dithering made the files nearly twice as large in our measurements.
  - WebP: libwebp's animated encoder at its default quality (75) and effort (4), at most 640 px and 20 fps; about a third of the GIF's size.
  - Smaller videos are not enlarged. Video effects, burned-in subtitles and the Collection's transitions are in the image as in a Precise MP4; the audio choice is greyed (no sound).
  - At most **60 seconds**: a longer range (a merged Collection: its length after the transitions) is refused before the save dialog, with the reason on the Clip page. Size estimates in the Export button's tip are a wide range per second.
  - The player writes an MP4 (at most 720p and 30 fps, best quality) into the plugin's work folder; the player's FFmpeg then writes the image beside the destination under a hidden name, which becomes the file when it is complete. A GIF takes two runs, the palette first, so memory stays small however long the clip.
  - Only when you chose Precise: with Fast chosen and a Collection Fast cannot join, the merge falls back to a Precise MP4 as before (High quality while an animated choice is kept), never to an image. Cancel, a failure and success leave no work file; Retry runs it again.
  - The plugin asks the player's FFmpeg which encoders it has: without a WebP encoder, Animated WebP says "The player's FFmpeg cannot write this format" and Animated GIF still works; without FFmpeg both say it is missing. Nothing starts in either case.
  - The ⓘ beside Fast | Precise says what the chosen image will be. The H.264 rows (resolution, frame rate, quality number, speed, AAC bitrate) are hidden while an animated choice is selected; Custom now comes after the two new choices.
- English, Simplified Chinese, German, Spanish, French, Japanese and Korean.

## 0.4.0

**Who must change: nobody.** No new permission and the same player (0.7.6 or later). Settings, the Collection and its transitions carry over; a tab last left on the Collection page opens on the Clip page, which now holds the Collection. Command ids and keys are unchanged.

- **One Clip page.** The Clip and Collection sub-tabs are one page: **Output** (Fast | Precise in one row, the ⓘ, Advanced folded), the **Range** card (the file playing, Start and End, Use A-B range, Last N s, **Export Clip**, Export As…), then the **Collection** with its count, **+ Add** and Clear in the header. The sub-tabs are Clip · Results · Settings.
- While the Collection has parts, a **footer** below the page shows its sum (parts, length, method, transitions), at most one note, **Export Merged** and Export As…. The highlighted button is the output being built: Export Clip while the Collection is empty, Export Merged once it has parts. On a very short tab the footer scrolls with the page, so the list keeps at least three rows.
- **Show Collection** opens the Clip page with the list in view and focused.
- **Transitions in Fast**: a junction chip opens the picker in Fast too. Picking a transition switches the method to Precise, and the footer says "Switched to Precise: transitions need re-encoding."; picking Cut keeps Fast. Parts that Fast cannot join behave as before.
- The picker opens only after the plugin has opened that junction, and closes when its junction goes (part removed or moved last, page left), so it never shows an empty "Transition 0 → 0".

## 0.3.1

**Who must change: nobody.** No new permission and the same player (0.7.6 or later).

- In Fast, every junction chip is greyed (a Cut too) and does not open the picker; before, a Cut's chip opened an empty picker (Transition 0 → 0) that changed nothing.
- Start and End show "-:--.---" until set, no longer a time that looked like a range.

## 0.3.0

**Who must change: nobody.** No new permission and the same player (0.7.6 or later). A Collection from 0.2.x loads unchanged: every junction is a Cut, so its export is the same file as before until you choose a transition.

- **Transitions between Collection parts.** Each junction has a row under its part with a chip (Cut by default). A click opens the picker: Cut, Crossfade, Fade through black, Fade through white, Wipe and Slide, each previewed with the two parts' own pictures; Wipe and Slide have a direction (the way the new picture moves); the length is 0.5, 1, 1.5 or 2 s or typed in 0.1 s steps, at most half of the shorter of the two parts (1 s when a kind is first picked). Sound follows the picture: a crossfade, or out-then-in for the fades through black and white.
- **Apply to All** puts the junction's transition on every junction (each held to its own limit) and makes it the default for new parts; the message offers Undo (also in the command palette: Undo Apply to All).
- A transition belongs to the end of its part: reordering carries it, the last part has none. The footer shows the written length and "2 transitions −2.5 s": the parts overlap by each transition, so the video is that much shorter, and it shows no frame outside the marked ranges.
- **Precise only.** With Fast, the transitions stay but are greyed and struck, the export joins with cuts ("Transitions: Precise only. Fast joins with cuts."). Precise exports the plain merge into the plugin's work folder, then the player's FFmpeg writes the transitions into the file with the Clip page's quality settings; the progress card says "transition 1 / 2". The junctions are found on the merged file itself (each part's real frames and start), so picture and sound meet at every junction. The free space beside the file is checked first ("Not enough disk space"). Cancel, a failure and success leave no work file and no half file; what a crash or a kill left is removed at the next start. "Same as source" aims at the parts' own bit rate, read when each part is added.
- English, Simplified Chinese, German, Spanish, French, Japanese and Korean.

## 0.2.1

**Who must change: nobody.** Two fixes of 0.2.0; still Vestra Player 0.7.6 or later.

- **Start and End belong to the file they were set on.** A new file (opened, from the playlist, or a part's double-click) no longer shows the last file's range (for example the same 0:20–0:29 on every video): its fields are empty until you set marks, as cut points are per file in LosslessCut. A part's double-click marks that part. Export Clip… fills the new file's position → +10 s; Add Range to Collection and Export Clip Range by key refuse with the reason when this file has no marks.
- **End is visible again** beside the time fields on the Collection page: the fields no longer ask for the std field's 160 px each (two of them pushed End out of the 317 px tab). Each time field is wide enough for a whole time (80 px). Start and End show their labels where the row has room for them in your language, their key caps where those fit too, and their glyphs alone otherwise (the label and key stay in the tooltip). The Clip page's Now buttons fit at the narrowest tab too.
- The range marks Start and End are translated as nouns ("the start", "the end") in every language; German, French, Spanish and Simplified Chinese had verbs.

## 0.2.0

**Who must change: nobody.** Needs Vestra Player 0.7.6 or later (remembered files and exports of several parts, SDK 1.7.8); the install asks for two more permissions, `media.sources` (remember the videos you add) and `playback.control` (play a part on double-click).

- **Collection page** (Clip · Collection · Results · Settings): collect ranges from several local files and export them as one merged video. **Add to Collection** takes the Clip page's Start and End of the file playing; the **Collection** button on the Clip page does the same. Rows with number, thumbnail (captured at the part's start while its file plays), file and range; drag a row to reorder, ✕ or Delete to remove, double-click to play the part, **Clear** with Undo on the message.
- **Export Merged** / **Export As…**: Fast copies the parts when the files match, otherwise one line says what differs ("Fast: part 2 is 1920×818, part 1 is 3840×1714") and Precise re-encodes to the first part's size and frame rate with the Clip page's quality settings. The same queue, progress card (with the part being written and ticks at the joins), Results row and "Clip exported" message as a clip.
- A part whose file was moved or changed says so on its row with **Locate…** (the player's file dialog); a red line says which part stops the export, and Export stays greyed until it is located or removed. The list is kept across restarts.
- Commands (Export): Add Range to Collection, Show Collection, Export Collection, Clear Collection, Undo Clear Collection, Remove from Collection (Delete in the list). No new default keys.
- The Now buttons show the keys of Set Clip Start / End when you bind them. Settings has a second file-name template, **Collection** (`{name}_collection_{date}`).
- Export As… (Clip page and Collection): the file name gets the extension of what is written; Precise is always `.mp4`, even when `.mkv` was typed (before, a Precise clip could be an MP4 named `.mkv`).
- The page shown last is kept by name; the one from 0.1.x is kept.

## 0.1.1

- Store icon.

## 0.1.0

- First release. Clip export moves out of the player's built-in Snapshot plugin into this store plugin; snapshots and bursts stay in the player. Nothing to migrate: the player with the old Capture tab was never released.
- One sidebar tab, **Clip Export**, with Clip, Results and Settings pages. **Video ▸ Export Clip…** opens it.
- **Fast** (stream copy from the keyframe at or before the start, MP4 or MKV) and **Precise** (re-encoded H.264 + AAC MP4 from the exact frame) exports, with a keyframe preview on a small timeline and size and time estimates.
- Range by typing, **Now**, **Use A-B range**, or **Last N s** (10, 30, 60 or 120 seconds, Ctrl+Shift+R); Export Clip Range is Ctrl+Shift+E.
- **Advanced**: audio track, quality presets (Same as source, High quality, Small file) or your own resolution, frame rate, quality number, speed and audio bitrate; video effects and burned-in subtitles (Precise).
- The clip's range on the seek bar while the tab is in front; the running export's progress and time left; one running and four queued exports; Retry keeps a failed export's input for five minutes.
- **Results**: the last twenty clips, kept across restarts, with thumbnails, Open, Show in Folder and Remove. The "Clip exported" message has Show in Folder and Show in Tab buttons.
- **Settings**: the clip folder (Videos by default) or beside the video, the file-name template, the Last N s length.
- English, Simplified Chinese, German, Spanish, French, Japanese and Korean.
- Needs Vestra Player 0.7.6 or later.
