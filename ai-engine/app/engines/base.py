import os
import cv2
import numpy as np
from abc import ABC, abstractmethod
from typing import Tuple, Dict, Any, List


class BaseFilterEngine(ABC):
    """
    Abstract base class for all image processing & filter engines.
    Provides standard interface and shared computer vision utilities.
    """
    def __init__(self, filter_id: str, name: str, category: str, description: str = ""):
        self.filter_id = filter_id
        self.name = name
        self.category = category
        self.description = description

        # Initialize Haar Cascades for facial landmark detection
        self.face_cascade = None
        self.eye_cascade = None
        self._init_cascades()

    def _init_cascades(self) -> None:
        """Loads pre-trained Haar Cascades from cv2.data."""
        try:
            face_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            eye_path = cv2.data.haarcascades + "haarcascade_eye.xml"
            if os.path.exists(face_path):
                self.face_cascade = cv2.CascadeClassifier(face_path)
            if os.path.exists(eye_path):
                self.eye_cascade = cv2.CascadeClassifier(eye_path)
        except Exception:
            self.face_cascade = None
            self.eye_cascade = None

    def detect_faces(self, img_gray: np.ndarray) -> List[Tuple[int, int, int, int]]:
        """Detect frontal faces returning [(x, y, w, h), ...]."""
        if self.face_cascade is None or self.face_cascade.empty():
            return []
        faces = self.face_cascade.detectMultiScale(
            img_gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(30, 30)
        )
        return [tuple(f) for f in faces]

    def detect_eyes(self, img_gray: np.ndarray, face_box: Tuple[int, int, int, int]) -> List[Tuple[int, int, int, int]]:
        """Detect eyes within face region."""
        if self.eye_cascade is None or self.eye_cascade.empty():
            return []
        fx, fy, fw, fh = face_box
        # Search primarily in the upper half of the face
        face_roi = img_gray[fy:fy + int(fh * 0.65), fx:fx + fw]
        eyes = self.eye_cascade.detectMultiScale(
            face_roi,
            scaleFactor=1.1,
            minNeighbors=4,
            minSize=(15, 15)
        )
        return [(fx + ex, fy + ey, ew, eh) for (ex, ey, ew, eh) in eyes]

    @abstractmethod
    def apply(self, img_rgb: np.ndarray, intensity: float = 1.0, **kwargs) -> Tuple[np.ndarray, Dict[str, Any]]:
        """
        Executes the filter on an input RGB uint8 image.
        Returns: (output_rgb_numpy_array, metadata_dictionary)
        """
        pass
