### Convert for Web

From [SO](https://stackoverflow.com/questions/7048406/image-magick-image-optimization-for-websites).

```
for X in *.JPG; do convert "$X" -resize 1024x768 -strip -quality 86 "$X"; done
```
