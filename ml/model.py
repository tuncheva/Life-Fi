"""CsiNet: the small 1D CNN of the transition model (model-training-plan §3.2).

Input: model view x [B, 52, 150] (3 s at 50 Hz, mean removed per
subcarrier). Subcarriers are channels; convolution runs over time only,
because the event is a shape in time and which subcarrier moves is a
property of the room. The BatchNorm layers are what AdaBN re-estimates in
a new room (adapt.py), so every conv is followed by one.
"""

import torch
from torch import nn


def block(cin, cout, k, dilation=1):
    return nn.Sequential(nn.Conv1d(cin, cout, k, padding=dilation * (k - 1) // 2, dilation=dilation),
                         nn.BatchNorm1d(cout), nn.ReLU())


class CsiNet(nn.Module):
    def __init__(self, n_classes=7, n_sub=52, width=64):
        super().__init__()
        self.features = nn.Sequential(
            block(n_sub, 32, 1),                       # mix subcarriers into 32 "virtual paths"
            block(32, width, 7), nn.MaxPool1d(2),      # short shapes, 75 steps
            block(width, width, 5, 2), nn.MaxPool1d(2),  # longer shapes, 37 steps
            block(width, width, 5, 4),                 # whole-event shapes
        )
        self.head = nn.Sequential(nn.Dropout(0.3), nn.Linear(2 * width, n_classes))

    def forward(self, x):
        h = self.features(x)
        h = torch.cat([h.mean(dim=-1), h.amax(dim=-1)], dim=1)   # "how much did each detector fire"
        return self.head(h)


def n_params(model):
    return sum(p.numel() for p in model.parameters())
