using System.Windows;
using System.Windows.Media;
using DragGroup.Core;

namespace DragGroup.Native;

// Shared by the actual transparent overlay and the off-screen visual preview.
internal sealed class FeedbackSurface : FrameworkElement
{
    public static readonly DependencyProperty AccentBrushProperty=DependencyProperty.Register(
        nameof(AccentBrush),typeof(Brush),typeof(FeedbackSurface),
        new FrameworkPropertyMetadata(SystemColors.AccentColorLight1Brush,FrameworkPropertyMetadataOptions.AffectsRender));
    public Brush AccentBrush {get=>(Brush)GetValue(AccentBrushProperty);set=>SetValue(AccentBrushProperty,value);}
    private readonly DrawingVisual ink=new();
    protected override int VisualChildrenCount=>1;
    protected override Visual GetVisualChild(int index)=>index==0?ink:throw new ArgumentOutOfRangeException(nameof(index));
    private Slot? source,target;
    private double originX,originY;
    private bool armed;
    public FeedbackSurface(){AddVisualChild(ink);SetResourceReference(AccentBrushProperty,SystemColors.AccentColorLight1BrushKey);}
    public void Clear()
    {
        if(source is null&&target is null&&!armed)return;
        source=target=null;armed=false;
        // Replace the retained drawing immediately, including while hidden.
        using var empty=ink.RenderOpen();
    }
    public void SetState(Slot source,Slot target,double originX,double originY,bool armed)
    {
        if(this.source==source&&this.target==target&&this.originX==originX&&this.originY==originY&&this.armed==armed)return;
        this.source=source;this.target=target;this.originX=originX;this.originY=originY;this.armed=armed;
        Paint();
    }
    internal static Geometry Contour(Slot slot,double originX,double originY,bool closed)
    {
        double scale=slot.Height/36,left=slot.X-originX,right=left+slot.Width;
        // UIA exposes the full hit rectangle, including the empty padding above
        // and beside Chrome's painted tab. Fit the contour to that inner shape;
        // keep the original baseline and all gesture hit rectangles unchanged.
        double top=slot.Y-originY+5.5*scale,bottom=slot.Y-originY+slot.Height-scale;
        double flare=Math.Min(slot.Width*.2,10*scale),radius=Math.Min(slot.Width*.13,7*scale);
        var geometry=new StreamGeometry();
        using(var path=geometry.Open())
        {
            path.BeginFigure(new(left+scale,bottom),closed,closed);
            path.QuadraticBezierTo(new(left+flare,bottom),new(left+flare,bottom-radius),true,false);
            path.LineTo(new(left+flare,top+radius),true,false);
            path.QuadraticBezierTo(new(left+flare,top),new(left+flare+radius,top),true,false);
            path.LineTo(new(right-flare-radius,top),true,false);
            path.QuadraticBezierTo(new(right-flare,top),new(right-flare,top+radius),true,false);
            path.LineTo(new(right-flare,bottom-radius),true,false);
            path.QuadraticBezierTo(new(right-flare,bottom),new(right-scale,bottom),true,false);
        }
        geometry.Freeze();return geometry;
    }
    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);Paint();
    }
    private void Paint()
    {
        using var drawing=ink.RenderOpen();
        if(source is null||target is null||!armed)return;
        // Slot/window bounds are physical pixels; WPF drawing units are DIPs.
        var dpi=VisualTreeHelper.GetDpi(this);
        drawing.PushTransform(new ScaleTransform(1/dpi.DpiScaleX,1/dpi.DpiScaleY));
        double scale=Math.Min(source.Height,target.Height)/36;
        var sourceMask=Contour(source,originX,originY,true);
        var targetMask=Contour(target,originX,originY,true);
        var visibleTarget=new CombinedGeometry(GeometryCombineMode.Exclude,targetMask,sourceMask);
        // A secondary selection tint distinguishes the stationary target.
        drawing.PushOpacity(.18);
        drawing.DrawGeometry(AccentBrush,null,visibleTarget);
        drawing.Pop();
        drawing.PushOpacity(.065);
        drawing.DrawGeometry(AccentBrush,null,sourceMask);
        drawing.Pop();
        // The front tab masks the rear outline without painting over Chrome's
        // native background, title, favicon or close button.
        var rearStroke=Contour(target,originX,originY,false).GetWidenedPathGeometry(new Pen(AccentBrush,1.75*scale));
        var visibleStroke=new CombinedGeometry(GeometryCombineMode.Exclude,rearStroke,sourceMask);
        drawing.PushOpacity(.9);
        drawing.DrawGeometry(AccentBrush,null,visibleStroke);
        drawing.Pop();
        drawing.PushOpacity(1);
        drawing.DrawGeometry(null,new Pen(AccentBrush,2.75*scale),Contour(source,originX,originY,false));
        // Both contours remain open at the bottom; no shared underline.
        drawing.Pop();drawing.Pop();
    }
}
