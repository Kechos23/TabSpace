using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using DragGroup.Core;
using DragGroup.Native;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var app=new Application();
        var root=new Canvas{Width=640,Height=720,Background=new SolidColorBrush(Color.FromRgb(11,29,48))};
        var cases=new[]{(120d,280d,240d,240d,"Right"),(280d,120d,240d,240d,"Left"),(180d,250d,100d,100d,"Narrow"),(130d,330d,240d,90d,"Mixed widths")};
        int row=0;
        foreach(var (sourceX,targetX,sourceWidth,targetWidth,label) in cases)
        foreach(bool armed in new[]{false,true})
        {
            var source=new Slot("source",sourceX,25,sourceWidth,36,false,"New tab");
            var target=new Slot("target",targetX,25,targetWidth,36,false,"New tab");
            var group=new DrawingGroup();
            using(var drawing=group.Open())
            {
                drawing.DrawRectangle(new SolidColorBrush(Color.FromRgb(11,29,48)),null,new Rect(0,0,640,90));
                void Text(string value,double x,double y,double size,Brush brush)=>drawing.DrawText(new FormattedText(value,CultureInfo.InvariantCulture,FlowDirection.LeftToRight,new Typeface("Segoe UI"),size,brush,1),new Point(x,y));
                Text($"{label} · {(armed?"READY":"HOLD")}",15,5,11,Brushes.LightSlateGray);
                drawing.DrawLine(new Pen(new SolidColorBrush(Color.FromRgb(43,76,106)),1),new(0,60),new(640,60));
                drawing.DrawGeometry(new SolidColorBrush(Color.FromRgb(18,43,72)),null,FeedbackSurface.Contour(target,0,0,true));
                Text("New tab",target.X+20,35,12,Brushes.White);Text("×",target.X+target.Width-25,32,16,Brushes.White);
                drawing.DrawGeometry(new SolidColorBrush(Color.FromRgb(26,64,105)),null,FeedbackSurface.Contour(source,0,0,true));
                Text("New tab",source.X+20,35,12,Brushes.White);Text("×",source.X+source.Width-25,32,16,Brushes.White);
            }
            var background=new System.Windows.Controls.Image{Source=new DrawingImage(group),Width=640,Height=90};
            Canvas.SetTop(background,row*90);root.Children.Add(background);
            var surface=new FeedbackSurface{Width=640,Height=90};
            surface.SetState(source,target,0,0,armed);
            Canvas.SetTop(surface,row*90);root.Children.Add(surface);row++;
        }
        root.Measure(new(640,720));root.Arrange(new(0,0,640,720));root.UpdateLayout();
        var image=new RenderTargetBitmap(640,720,96,96,PixelFormats.Pbgra32);image.Render(root);
        var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(image));
        string output=Path.GetFullPath(args[0]);Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        using(var stream=File.Create(output))encoder.Save(stream);
        Console.WriteLine($"Rendered actual shared FeedbackSurface to {output}; no desktop window or mouse input.");
        // Repeated de-selection must empty the retained drawing synchronously,
        // even before the next layout/render pass or when the HWND is hidden.
        var probe=new FeedbackSurface{Width=640,Height=90};
        probe.Measure(new(640,90));probe.Arrange(new Rect(0,0,640,90));probe.UpdateLayout();
        byte[] Pixels(){var bitmap=new RenderTargetBitmap(640,90,96,96,PixelFormats.Pbgra32);bitmap.Render(probe);var pixels=new byte[640*90*4];bitmap.CopyPixels(pixels,640*4,0);return pixels;}
        var firstSource=new Slot("source",120,25,100,36,false,"A");var firstTarget=new Slot("target",240,25,100,36,false,"B");
        for(int cycle=0;cycle<100;cycle++){
            probe.SetState(firstSource,firstTarget,0,0,true);
            if(!Pixels().Where((v,i)=>i%4==3).Any(v=>v!=0))throw new Exception("Ready feedback did not render");
            probe.Clear();
            if(Pixels().Where((v,i)=>i%4==3).Any(v=>v!=0))throw new Exception("De-selection left retained ink");
        }
        probe.SetState(firstSource,firstTarget,0,0,true);
        probe.SetState(firstSource with{X=380},firstTarget with{X=500},0,0,true);
        var replaced=Pixels();
        for(int y=0;y<90;y++)for(int x=0;x<350;x++)if(replaced[(y*640+x)*4+3]!=0)throw new Exception("Old target survived replacement");
        probe.Clear();probe.SetState(firstSource,firstTarget,0,0,false);
        if(Pixels().Where((v,i)=>i%4==3).Any(v=>v!=0))throw new Exception("Pending feedback should be empty");
        Console.WriteLine("Passed 100 actual WPF draw/clear cycles, target replacement and pending-state pixel checks.");
        app.Shutdown();
    }
}
