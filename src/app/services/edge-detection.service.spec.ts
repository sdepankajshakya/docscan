import { TestBed } from '@angular/core/testing';
import { EdgeDetectionService, Point } from './edge-detection.service';

describe('EdgeDetectionService', () => {
    let service: EdgeDetectionService;
    const originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;

    beforeAll(async () => {
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
        const svc = new EdgeDetectionService();
        await svc['loadOpenCV']();
    });

    afterAll(() => {
        jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
    });

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [EdgeDetectionService]
        });
        service = TestBed.inject(EdgeDetectionService);
    });

    it('should be created', () => {
        expect(service).toBeTruthy();
    });

    describe('orderPoints', () => {
        it('should correctly order upright rectangle points clockwise starting from top-left', () => {
            const unordered: Point[] = [
                { x: 100, y: 200 }, // bottom-right
                { x: 20, y: 10 },   // top-left
                { x: 20, y: 200 },  // bottom-left
                { x: 100, y: 10 }   // top-right
            ];

            const ordered = service.orderPoints(unordered);

            expect(ordered.length).toBe(4);
            expect(ordered[0]).toEqual({ x: 20, y: 10 });   // top-left
            expect(ordered[1]).toEqual({ x: 100, y: 10 });  // top-right
            expect(ordered[2]).toEqual({ x: 100, y: 200 }); // bottom-right
            expect(ordered[3]).toEqual({ x: 20, y: 200 });  // bottom-left
        });

        it('should correctly order tilted/rotated document points', () => {
            // Tilted document rotated ~15 degrees
            const tilted: Point[] = [
                { x: 261, y: 34 },  // top-right
                { x: 114, y: 216 }, // bottom-left
                { x: 122, y: 18 },  // top-left
                { x: 246, y: 225 }  // bottom-right
            ];

            const ordered = service.orderPoints(tilted);

            expect(ordered[0]).toEqual({ x: 122, y: 18 });  // top-left
            expect(ordered[1]).toEqual({ x: 261, y: 34 });  // top-right
            expect(ordered[2]).toEqual({ x: 246, y: 225 }); // bottom-right
            expect(ordered[3]).toEqual({ x: 114, y: 216 }); // bottom-left
        });

        it('should return points as-is if count is not 4', () => {
            const threePoints: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }];
            expect(service.orderPoints(threePoints)).toEqual(threePoints);
        });
    });

    describe('detectDocumentEdges', () => {
        it('should return null when confidence is insufficient on a blank image', async () => {
            // Create a blank 300x300 canvas
            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 300;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#808080';
            ctx.fillRect(0, 0, 300, 300);

            const blankDataUrl = canvas.toDataURL('image/jpeg');
            const result = await service.detectDocumentEdges(blankDataUrl);

            // Blank image has no document contours or insufficient confidence -> null
            expect(result).toBeNull();
        });

        it('should return null when given an invalid or empty image URL', async () => {
            const result = await service.detectDocumentEdges('data:image/jpeg;base64,invalid');
            expect(result).toBeNull();
        });

        it('should detect four document corners for a high-contrast document on a background', async () => {
            // Create a 400x300 image with a dark background and a centered white document
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 300;
            const ctx = canvas.getContext('2d')!;

            // Dark wood-like background
            ctx.fillStyle = '#2b1d0c';
            ctx.fillRect(0, 0, 400, 300);

            // Document in center: x from 80 to 320 (width 240), y from 50 to 250 (height 200)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(80, 50, 240, 200);

            const docDataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(docDataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                expect(Math.abs(corners[0].x - 80)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[0].y - 50)).toBeLessThanOrEqual(5);

                expect(Math.abs(corners[1].x - 320)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[1].y - 50)).toBeLessThanOrEqual(5);

                expect(Math.abs(corners[2].x - 320)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[2].y - 250)).toBeLessThanOrEqual(5);

                expect(Math.abs(corners[3].x - 80)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[3].y - 250)).toBeLessThanOrEqual(5);
            }
        });

        it('should detect rotated documents (like Doc 0 test case)', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 300;
            const ctx = canvas.getContext('2d')!;

            // Background
            ctx.fillStyle = '#3a2618';
            ctx.fillRect(0, 0, 400, 300);

            // Draw rotated document
            ctx.save();
            ctx.translate(200, 150);
            ctx.rotate(0.12); // ~7 degrees tilt
            ctx.fillStyle = '#c0c0c0';
            ctx.fillRect(-70, -100, 140, 200);
            ctx.restore();

            const docDataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(docDataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Verify clockwise ordering
                expect(corners[0].x).toBeLessThan(corners[1].x);
                expect(corners[3].x).toBeLessThan(corners[2].x);
                expect(corners[0].y).toBeLessThan(corners[3].y);
                expect(corners[1].y).toBeLessThan(corners[2].y);
            }
        });

        it('should avoid detecting nearby objects like pens and cups (like Doc 1 test case)', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            const ctx = canvas.getContext('2d')!;

            // Light beige table background
            ctx.fillStyle = '#c5b8a5';
            ctx.fillRect(0, 0, 400, 400);

            // White document in center: 100, 60 to 300, 340 (width 200, height 280)
            ctx.fillStyle = '#f5f5f5';
            ctx.fillRect(100, 60, 200, 280);

            // Pen on right side (dark thin rectangle outside document)
            ctx.fillStyle = '#111111';
            ctx.fillRect(330, 150, 15, 120);

            // Cup on top-left (circle outside document)
            ctx.beginPath();
            ctx.arc(50, 50, 30, 0, 2 * Math.PI);
            ctx.fillStyle = '#e0ded8';
            ctx.fill();

            const docDataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(docDataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Corners must be on the document, not on the pen (x=330) or cup (x=50)
                expect(Math.abs(corners[0].x - 100)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[0].y - 60)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[1].x - 300)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[1].y - 60)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[2].x - 300)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[2].y - 340)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[3].x - 100)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[3].y - 340)).toBeLessThanOrEqual(10);
            }
        });

        it('should detect elongated receipts with internal text/barcode (like Doc 2 test case)', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 300;
            const ctx = canvas.getContext('2d')!;

            // Dark wood table
            ctx.fillStyle = '#2d1e12';
            ctx.fillRect(0, 0, 400, 300);

            // Receipt paper in center: 40, 90 to 360, 210 (width 320, height 120, ~2.67:1 aspect ratio)
            ctx.fillStyle = '#e8e8e6';
            ctx.fillRect(40, 90, 320, 120);

            // Simulated internal barcode lines
            ctx.fillStyle = '#333333';
            for (let x = 200; x < 280; x += 4) {
                ctx.fillRect(x, 110, 2, 70);
            }

            // Simulated text lines
            for (let y = 105; y < 190; y += 15) {
                ctx.fillRect(60, y, 100, 4);
            }

            const docDataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(docDataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Corners must be on the receipt boundary, not the barcode lines or text lines
                expect(Math.abs(corners[0].x - 40)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[0].y - 90)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[1].x - 360)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[1].y - 90)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[2].x - 360)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[2].y - 210)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[3].x - 40)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[3].y - 210)).toBeLessThanOrEqual(10);
            }
        });

        it('should detect small documents occupying only a fraction of the image on textured low-contrast background (like Sofa case)', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            const ctx = canvas.getContext('2d')!;

            // Beige textured background (like a sofa cushion)
            ctx.fillStyle = '#d4cbb8';
            ctx.fillRect(0, 0, 400, 400);

            // Background folds/creases (simulating sofa seams)
            ctx.strokeStyle = '#b0a38f';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, 100);
            ctx.bezierCurveTo(150, 120, 250, 80, 400, 110);
            ctx.stroke();

            // Small folded document in center: width 90, height 120 (~6.7% of image)
            // Color is light off-white (low contrast against beige)
            ctx.fillStyle = '#ece8df';
            ctx.fillRect(155, 140, 90, 120);

            // Text on paper
            ctx.fillStyle = '#555555';
            for (let y = 155; y < 245; y += 10) {
                ctx.fillRect(165, y, 70, 3);
            }

            const docDataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(docDataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Corners must be on the small document, not the background cushion or seams
                expect(Math.abs(corners[0].x - 155)).toBeLessThanOrEqual(12);
                expect(Math.abs(corners[0].y - 140)).toBeLessThanOrEqual(12);
                expect(Math.abs(corners[1].x - 245)).toBeLessThanOrEqual(12);
                expect(Math.abs(corners[1].y - 140)).toBeLessThanOrEqual(12);
                expect(Math.abs(corners[2].x - 245)).toBeLessThanOrEqual(12);
                expect(Math.abs(corners[2].y - 260)).toBeLessThanOrEqual(12);
                expect(Math.abs(corners[3].x - 155)).toBeLessThanOrEqual(12);
                expect(Math.abs(corners[3].y - 260)).toBeLessThanOrEqual(12);
            }
        });

        it('should detect narrow hand-held receipts with finger overlaps (like Staples case)', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 500;
            const ctx = canvas.getContext('2d')!;

            // Neutral wall background
            ctx.fillStyle = '#7a7a76';
            ctx.fillRect(0, 0, 400, 500);

            // Receipt paper in center: 150, 120 to 260, 380 (width 110, height 260)
            ctx.fillStyle = '#f0ede6';
            ctx.fillRect(150, 120, 110, 260);

            // Receipt text and barcode
            ctx.fillStyle = '#222222';
            for (let y = 140; y < 320; y += 12) {
                ctx.fillRect(160, y, 80, 3);
            }
            for (let x = 165; x < 240; x += 3) {
                ctx.fillRect(x, 340, 2, 25);
            }

            // Finger overlapping left edge (thumb at x=145 to 165, y=230 to 280)
            ctx.fillStyle = '#8b5a40';
            ctx.beginPath();
            ctx.ellipse(150, 255, 15, 25, 0, 0, 2 * Math.PI);
            ctx.fill();

            // Fingers overlapping right edge
            ctx.beginPath();
            ctx.ellipse(260, 220, 12, 18, 0, 0, 2 * Math.PI);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(260, 260, 12, 18, 0, 0, 2 * Math.PI);
            ctx.fill();

            const docDataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(docDataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Corners should closely match the receipt perimeter
                expect(Math.abs(corners[0].x - 150)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[0].y - 120)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].x - 260)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].y - 120)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[2].x - 260)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[2].y - 380)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[3].x - 150)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[3].y - 380)).toBeLessThanOrEqual(15);
            }
        });

        it('should detect the complete folded receipt including the barcode section rather than truncating at internal folds', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 500;
            const ctx = canvas.getContext('2d')!;

            // Neutral background
            ctx.fillStyle = '#656565';
            ctx.fillRect(0, 0, 400, 500);

            // Receipt paper: x=150..250 (width 100), y=110..370 (height 260)
            ctx.fillStyle = '#f2efe9';
            ctx.fillRect(150, 110, 100, 260);

            // Header text
            ctx.fillStyle = '#222222';
            ctx.fillRect(165, 125, 70, 8);
            ctx.fillRect(160, 140, 80, 4);

            // Fold crease 1 (shadow line at y=180)
            ctx.fillStyle = '#b8b4ab';
            ctx.fillRect(150, 178, 100, 3);

            // Body text lines
            ctx.fillStyle = '#333333';
            for (let y = 195; y < 310; y += 14) {
                ctx.fillRect(160, y, 80, 3);
            }

            // Fold crease 2 (shadow line at y=320)
            ctx.fillStyle = '#b8b4ab';
            ctx.fillRect(150, 318, 100, 3);

            // Barcode section at bottom: y=330..365
            ctx.fillStyle = '#111111';
            for (let x = 160; x < 240; x += 3) {
                ctx.fillRect(x, 332, 2, 28);
            }

            const docDataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(docDataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Top corners near y=110
                expect(Math.abs(corners[0].x - 150)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[0].y - 110)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].x - 250)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].y - 110)).toBeLessThanOrEqual(15);
                // Bottom corners must include the barcode section (y near 370, NOT truncated at crease y=320)
                expect(Math.abs(corners[2].x - 250)).toBeLessThanOrEqual(15);
                expect(corners[2].y).toBeGreaterThan(350);
                expect(Math.abs(corners[3].x - 150)).toBeLessThanOrEqual(15);
                expect(corners[3].y).toBeGreaterThan(350);
            }
        });

        it('should select outer paper boundaries over inner text blocks on a wrinkled document on a dark surface', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            const ctx = canvas.getContext('2d')!;

            // Dark chair / desk background
            ctx.fillStyle = '#181818';
            ctx.fillRect(0, 0, 400, 400);

            // Outer paper boundaries: x=100..260 (width 160), y=130..330 (height 200)
            ctx.fillStyle = '#e8e5de';
            ctx.fillRect(100, 130, 160, 200);

            // Wrinkle creases across paper
            ctx.strokeStyle = '#cbc7be';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(100, 200);
            ctx.lineTo(260, 220);
            ctx.stroke();

            // Inner dense text block: x=130..230 (width 100), y=160..290 (height 130)
            ctx.fillStyle = '#222222';
            for (let y = 165; y < 285; y += 10) {
                ctx.fillRect(130, y, 100, 4);
            }

            const docDataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(docDataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Corners must be on the outer paper sheet (x ~ 100 and 260, y ~ 130 and 330), NOT the inner text block
                expect(Math.abs(corners[0].x - 100)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[0].y - 130)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].x - 260)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].y - 130)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[2].x - 260)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[2].y - 330)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[3].x - 100)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[3].y - 330)).toBeLessThanOrEqual(15);
            }
        });

        it('should detect document boundaries on a high-frequency grid surface like a keyboard', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            const ctx = canvas.getContext('2d')!;

            // Keyboard grid background (dark keys with gap lines)
            ctx.fillStyle = '#1e1e1e';
            ctx.fillRect(0, 0, 400, 400);
            ctx.fillStyle = '#2d2d2d';
            for (let ky = 10; ky < 390; ky += 24) {
                for (let kx = 10; kx < 390; kx += 30) {
                    ctx.fillRect(kx, ky, 26, 20);
                }
            }

            // White receipt on keyboard: x=130..270 (width 140), y=90..310 (height 220)
            ctx.fillStyle = '#f5f5f3';
            ctx.fillRect(130, 90, 140, 220);

            // Receipt text
            ctx.fillStyle = '#333333';
            for (let y = 110; y < 290; y += 15) {
                ctx.fillRect(145, y, 110, 3);
            }

            const docDataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(docDataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Receipt must be detected despite keyboard keycap edges
                expect(Math.abs(corners[0].x - 130)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[0].y - 90)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].x - 270)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].y - 90)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[2].x - 270)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[2].y - 310)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[3].x - 130)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[3].y - 310)).toBeLessThanOrEqual(15);
            }
        });

        it('should detect entire bifold / two-page document rather than only a single page', async () => {
            // Create a 500x400 canvas with a dark background and an open two-page sheet (bifold)
            const canvas = document.createElement('canvas');
            canvas.width = 500;
            canvas.height = 400;
            const ctx = canvas.getContext('2d')!;

            // Dark piano-like background
            ctx.fillStyle = '#1c1b18';
            ctx.fillRect(0, 0, 500, 400);

            // Left page: x: 100 to 240, y: 80 to 320
            ctx.fillStyle = '#f4eedb';
            ctx.fillRect(100, 80, 140, 240);

            // Right page: x: 245 to 385, y: 80 to 320
            ctx.fillStyle = '#ede5d0';
            ctx.fillRect(245, 80, 140, 240);

            // Central vertical spine / shadow between pages: x: 240 to 245
            ctx.fillStyle = '#4a4435';
            ctx.fillRect(240, 80, 5, 240);

            // Music score lines on both pages
            ctx.fillStyle = '#2b2a26';
            for (let y = 110; y <= 290; y += 30) {
                ctx.fillRect(115, y, 110, 2);
                ctx.fillRect(260, y, 110, 2);
            }

            const dataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(dataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Detection must span BOTH pages: x ~100 to x ~385, y ~80 to y ~320
                expect(Math.abs(corners[0].x - 100)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[0].y - 80)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].x - 385)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[1].y - 80)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[2].x - 385)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[2].y - 320)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[3].x - 100)).toBeLessThanOrEqual(15);
                expect(Math.abs(corners[3].y - 320)).toBeLessThanOrEqual(15);
            }
        });

        it('should detect a blank document with high accuracy (blank paper preservation)', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 300;
            const ctx = canvas.getContext('2d')!;

            // Dark desk surface
            ctx.fillStyle = '#221e1a';
            ctx.fillRect(0, 0, 400, 300);

            // Completely blank white sheet of paper: 100, 50 to 300, 250 (width 200, height 200)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(100, 50, 200, 200);

            const dataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(dataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                expect(Math.abs(corners[0].x - 100)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[0].y - 50)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[1].x - 300)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[1].y - 50)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[2].x - 300)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[2].y - 250)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[3].x - 100)).toBeLessThanOrEqual(5);
                expect(Math.abs(corners[3].y - 250)).toBeLessThanOrEqual(5);
            }
        });

        it('should select document rather than container support surface (Adaptive Hierarchy / Rec 5)', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 500;
            canvas.height = 500;
            const ctx = canvas.getContext('2d')!;

            // Floor
            ctx.fillStyle = '#202020';
            ctx.fillRect(0, 0, 500, 500);

            // Outer dark support surface (e.g. green clipboard or filing drawer): 60, 40 to 440, 460
            ctx.fillStyle = '#1c3b24';
            ctx.fillRect(60, 40, 380, 420);

            // Inner white document on support: 130, 90 to 370, 410
            ctx.fillStyle = '#f8f8f8';
            ctx.fillRect(130, 90, 240, 320);

            // Printed text lines on inner document
            ctx.fillStyle = '#333333';
            for (let y = 130; y < 380; y += 14) {
                ctx.fillRect(150, y, 200, 3);
            }

            const dataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(dataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Must detect inner document (x ~130 to 370, y ~90 to 410), NOT outer clipboard (x ~60, y ~40)
                expect(Math.abs(corners[0].x - 130)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[0].y - 90)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[1].x - 370)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[1].y - 90)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[2].x - 370)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[2].y - 410)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[3].x - 130)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[3].y - 410)).toBeLessThanOrEqual(10);
            }
        });

        it('should reject non-normal background seams across document (Directed Gradient / Rec 1)', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            const ctx = canvas.getContext('2d')!;

            // Wood floor background
            ctx.fillStyle = '#6b4d32';
            ctx.fillRect(0, 0, 400, 400);

            // High-contrast longitudinal plank seam extending far past document to the right
            ctx.fillStyle = '#1a1008';
            ctx.fillRect(0, 280, 400, 4);

            // Document on floor: 80, 80 to 280, 280
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(80, 80, 200, 200);

            // Text on document
            ctx.fillStyle = '#333333';
            for (let y = 100; y < 260; y += 15) {
                ctx.fillRect(100, y, 160, 3);
            }

            const dataUrl = canvas.toDataURL('image/jpeg');
            const corners = await service.detectDocumentEdges(dataUrl);

            expect(corners).not.toBeNull();
            if (corners) {
                expect(corners.length).toBe(4);
                // Must stay bounded to document (x ~80 to 280), NOT stretching along plank seam to x=400
                expect(Math.abs(corners[0].x - 80)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[0].y - 80)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[1].x - 280)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[1].y - 80)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[2].x - 280)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[2].y - 280)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[3].x - 80)).toBeLessThanOrEqual(10);
                expect(Math.abs(corners[3].y - 280)).toBeLessThanOrEqual(10);
            }
        });
    });

    describe('perspectiveTransform', () => {
        it('should return null if corners length is not 4', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 100;
            canvas.height = 100;
            const result = await service.perspectiveTransform(canvas.toDataURL(), []);
            expect(result).toBeNull();
        });

        it('should transform document image given four corners', async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 200;
            canvas.height = 200;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(0, 0, 200, 200);

            const corners: Point[] = [
                { x: 20, y: 20 },
                { x: 180, y: 20 },
                { x: 180, y: 180 },
                { x: 20, y: 180 }
            ];

            const result = await service.perspectiveTransform(canvas.toDataURL(), corners);
            expect(result).toBeTruthy();
            expect(result?.startsWith('data:image/jpeg')).toBeTrue();
        });
    });
});
