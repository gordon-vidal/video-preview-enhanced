# Playback and A–B range feedback

The seek and volume focus rings linger after pointer drags. Playback toggles are easy to miss when the transport bar is out of view, and the seek bar's shaded span gives little feedback when setting a single A–B point.

```text
┌────────────────── Stage ──────────────────┐
│                                            │
│                    (▶)                     │
│                                            │
└────────────────────────────────────────────┘
            A                   B
────────────│═══════════════════│─────────────
```

- Tab shows the theme's focus ring on the **Position** and **Volume** sliders.
- Click the picture or press Space or K to toggle playback. The centered circle shows the new state and fades. With reduced motion enabled it stays the same size. The circle is decorative and hidden from assistive technology. The transport button still has the accessible action name **Play** or **Pause**.
- A or B toggles its labeled pin. The shaded band appears once both are set. The Settings row is named **A–B range** and the status announcement describes the range used for looping and export.
